#include "MacExplorerSMB.h"
#include <MacExplorerSMB2Includes.h>
#include <smb2/smb2-errors.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/ioccom.h>
#include <netdb.h>
#include <netinet/in.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <poll.h>
#include <time.h>

#ifndef MX_SMB_TIMEOUT_SECONDS
#define MX_SMB_TIMEOUT_SECONDS 30
#endif
struct mx_smb_session { struct smb2_context *smb; uint32_t source_tree, destination_tree; int broken, socket_error; mx_smb_metrics metrics; };
struct mx_remote { smb2_file_id id; };
enum response_kind { CONNECT, TREE, CREATE, QUERY, RESUME, CHUNK, CLOSE, DIRECTORY };
struct reply {
  int done, status; enum response_kind kind; uint32_t tree;
  struct smb2_create_reply create;
  struct smb2_stat_64 stat;
  struct smb2_srv_copychunk_resume_key key;
  struct smb2_srv_copychunk_reply chunk;
  uint8_t *directory; uint32_t directory_length;
};
/* libsmb2 writes immediately while queueing. Configure each socket before its first
   negotiate/authentication write; never change the application's SIGPIPE handler. */
static void socket_changed(struct smb2_context *smb, t_socket fd, int command) {
  if (command != SMB2_ADD_FD) return;
  mx_smb_session *s = smb2_get_opaque(smb);
  int enabled = 1;
  if (setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled)) != 0)
    s->socket_error = errno ? errno : EIO;
}
static void receive_reply(struct smb2_context *smb, int status, void *data, void *private) {
  struct reply *r = private; r->status = status;
  if (!status) {
    if (r->kind == TREE && smb2_get_tree_id_for_pdu(smb, NULL, &r->tree)) r->status = SMB2_STATUS_INTERNAL_ERROR;
    if (r->kind == CREATE) {
      if (data) r->create = *(struct smb2_create_reply *)data; else r->status = SMB2_STATUS_INTERNAL_ERROR;
    }
    if (r->kind == QUERY) {
      struct smb2_query_info_reply *rep = data;
      struct smb2_file_all_info *f = rep ? rep->output_buffer : NULL;
      if (!f) r->status = SMB2_STATUS_INTERNAL_ERROR;
      else {
        r->stat.smb2_ino = f->index_number; r->stat.smb2_size = f->standard.end_of_file;
        r->stat.smb2_type = f->standard.directory ? SMB2_TYPE_DIRECTORY : SMB2_TYPE_FILE;
        r->stat.smb2_attributes = f->basic.file_attributes;
        r->stat.smb2_btime = f->basic.creation_time.tv_sec; r->stat.smb2_btime_nsec = f->basic.creation_time.tv_usec * 1000;
        r->stat.smb2_mtime = f->basic.last_write_time.tv_sec; r->stat.smb2_mtime_nsec = f->basic.last_write_time.tv_usec * 1000;
        smb2_free_data(smb, f);
      }
    }
  }
  if (r->kind == RESUME && !status) {
    struct smb2_ioctl_reply *rep = data;
    if (rep && rep->output) { r->key = *(struct smb2_srv_copychunk_resume_key *)rep->output; smb2_free_data(smb, rep->output); }
    else r->status = SMB2_STATUS_INTERNAL_ERROR;
  }
  if (r->kind == CHUNK && (!status || (uint32_t)status == SMB2_STATUS_INVALID_PARAMETER)) {
    struct smb2_ioctl_reply *rep = data;
    if (rep && rep->output) { r->chunk = *(struct smb2_srv_copychunk_reply *)rep->output; smb2_free_data(smb, rep->output); }
    else if (!status) r->status = SMB2_STATUS_INTERNAL_ERROR;
  }
  if (r->kind == DIRECTORY && !status) {
    struct smb2_query_directory_reply *rep = data;
    if (!rep || !rep->output_buffer || !rep->output_buffer_length || rep->output_buffer_length > 65536) r->status = SMB2_STATUS_INVALID_NETWORK_RESPONSE;
    else {
      r->directory = malloc(rep->output_buffer_length);
      if (!r->directory) r->status = SMB2_STATUS_NO_MEMORY;
      else { memcpy(r->directory, rep->output_buffer, rep->output_buffer_length); r->directory_length = rep->output_buffer_length; }
    }
  }
  r->done = 1;
}
static double monotonic_seconds(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }
/* Callback storage stays alive until completion or context destruction. No library sync wait loop
   is used. A transport failure destroys pending requests before returning to stack-owned callers. */
static int await_reply(mx_smb_session *s, struct reply *r) {
  s->metrics.request_count++;
  double deadline = monotonic_seconds() + MX_SMB_TIMEOUT_SECONDS; int failure = 0;
  while (!r->done) {
    if (s->socket_error) { failure = -s->socket_error; break; }
    struct pollfd fd = { .fd = smb2_get_fd(s->smb), .events = smb2_which_events(s->smb) };
    if (fd.fd < 0) { failure = -ENOTCONN; break; }
    int ret = poll(&fd, 1, 100);
    if (ret < 0 && errno == EINTR) continue;
    if (ret < 0) { failure = -errno; break; }
    int serviced = smb2_service(s->smb, ret ? fd.revents : 0);
    if (serviced < 0 && !r->done) { failure = -ECONNRESET; break; }
    if (!r->done && monotonic_seconds() >= deadline) { failure = -ETIMEDOUT; break; }
  }
  if (failure) { s->broken = 1; smb2_destroy_context(s->smb); s->smb = NULL; return failure; }
  if (!r->status) return 0;
  return r->kind == CONNECT ? r->status : -nterror_to_errno((uint32_t)r->status);
}
static int submit(mx_smb_session *s, struct smb2_pdu *pdu, struct reply *r) {
  if (!pdu) return -ENOMEM;
  smb2_queue_pdu(s->smb, pdu); return await_reply(s, r);
}
mx_smb_session *mx_smb_connect(const char *server, const char *source_share,
  const char *destination_share, const char *user, const char *domain,
  const char *password, int require_encryption, int *error_code) {
  if (error_code) *error_code = EINVAL;
  if (!server || !source_share || !destination_share || !user || !*user || !password) return NULL;
  mx_smb_session *s = calloc(1, sizeof(*s)); if (!s) return NULL;
  s->smb = smb2_init_context(); if (!s->smb) { free(s); return NULL; }
  smb2_set_opaque(s->smb, s);
  smb2_fd_event_callbacks(s->smb, socket_changed, NULL);
  smb2_set_timeout(s->smb, MX_SMB_TIMEOUT_SECONDS);
  smb2_set_version(s->smb, require_encryption ? SMB2_VERSION_ANY3 : SMB2_VERSION_ANY);
  smb2_set_authentication(s->smb, SMB2_SEC_NTLMSSP);
  smb2_set_security_mode(s->smb, SMB2_NEGOTIATE_SIGNING_ENABLED | SMB2_NEGOTIATE_SIGNING_REQUIRED);
  smb2_set_sign(s->smb, 1);
  if (require_encryption) smb2_set_seal(s->smb, 1);
  smb2_set_user(s->smb, user); smb2_set_domain(s->smb, domain ? domain : ""); smb2_set_password(s->smb, password);
  struct reply auth = { .kind = CONNECT };
  int ret = smb2_connect_share_async(s->smb, server, source_share, user, receive_reply, &auth);
  if (ret) goto fail;
  ret = await_reply(s, &auth); if (ret) goto fail;
  ret = smb2_get_tree_id_for_pdu(s->smb, NULL, &s->source_tree); if (ret) goto fail;
  size_t n = strlen(server) + strlen(destination_share) + 5;
  char *unc = calloc(n, 1); if (!unc) { ret = -ENOMEM; goto fail; }
  snprintf(unc, n, "\\\\%s\\%s", server, destination_share);
  struct smb2_utf16 *utf = smb2_utf8_to_utf16(unc); free(unc);
  if (!utf) { ret = -EINVAL; goto fail; }
  struct smb2_tree_connect_request req = {0}; req.path_length = utf->len * 2; req.path = utf->val;
  struct reply tree = { .kind = TREE }; struct smb2_pdu *pdu = smb2_cmd_tree_connect_async(s->smb, &req, receive_reply, &tree);
  free(utf); ret = submit(s, pdu, &tree); if (ret) goto fail;
  s->destination_tree = tree.tree;
  if (error_code) *error_code = 0; return s;
fail:
  if (error_code) *error_code = ret < 0 ? -ret : EIO;
  mx_smb_destroy(s); return NULL;
}
void mx_smb_destroy(mx_smb_session *s) { if (!s) return; if (s->smb) smb2_destroy_context(s->smb); free(s); }
static int select_tree(mx_smb_session *s, uint32_t tree) { return s->broken || !s->smb ? -ENOTCONN : smb2_select_tree_id(s->smb, tree); }
static int close_remote(mx_smb_session *s, struct mx_remote *remote) {
  int ret = 0;
  if (s->smb && !s->broken) {
    struct smb2_close_request req = {0}; memcpy(req.file_id, remote->id, sizeof(req.file_id));
    struct reply r = { .kind = CLOSE }; ret = submit(s, smb2_cmd_close_async(s->smb, &req, receive_reply, &r), &r);
  }
  free(remote); return ret;
}
static struct mx_remote *open_existing(mx_smb_session *s, uint32_t tree, const char *path, int directory, int write) {
  if (select_tree(s, tree)) return NULL;
  struct mx_remote *remote = calloc(1, sizeof(*remote)); if (!remote) return NULL;
  struct smb2_create_request req = {0}; req.name = path;
  req.impersonation_level = SMB2_IMPERSONATION_IMPERSONATION;
  req.desired_access = SMB2_FILE_READ_ATTRIBUTES | (directory ? 0 : SMB2_FILE_READ_DATA) | (write ? SMB2_FILE_WRITE_DATA : 0);
  req.share_access = SMB2_FILE_SHARE_READ | (write || directory ? SMB2_FILE_SHARE_WRITE : 0);
  req.create_disposition = SMB2_FILE_OPEN;
  req.create_options = SMB2_FILE_OPEN_REPARSE_POINT | (directory ? SMB2_FILE_DIRECTORY_FILE : SMB2_FILE_NON_DIRECTORY_FILE);
  struct reply r = { .kind = CREATE };
  if (submit(s, smb2_cmd_create_async(s->smb, &req, receive_reply, &r), &r)) { free(remote); return NULL; }
  memcpy(remote->id, r.create.file_id, sizeof(remote->id));
  if (r.create.file_attributes & SMB2_FILE_ATTRIBUTE_REPARSE_POINT) { close_remote(s, remote); return NULL; }
  return remote;
}
static int remote_stat(mx_smb_session *s, struct mx_remote *remote, struct smb2_stat_64 *out) {
  if (s->broken) return -ENOTCONN;
  struct smb2_query_info_request req = {0}; req.info_type = SMB2_0_INFO_FILE; req.file_info_class = SMB2_FILE_ALL_INFORMATION;
  req.output_buffer_length = 65536; memcpy(req.file_id, remote->id, sizeof(req.file_id));
  struct reply r = { .kind = QUERY }; int ret = submit(s, smb2_cmd_query_info_async(s->smb, &req, receive_reply, &r), &r);
  if (!ret) *out = r.stat; return ret;
}
static int request_key(mx_smb_session *s, struct mx_remote *remote, struct smb2_srv_copychunk_resume_key *out) {
  struct smb2_ioctl_request req = {0}; req.ctl_code = SMB2_FSCTL_SRV_REQUEST_RESUME_KEY; req.flags = SMB2_0_IOCTL_IS_FSCTL;
  req.max_output_response = 32; memcpy(req.file_id, remote->id, sizeof(req.file_id));
  struct reply r = { .kind = RESUME }; int ret = submit(s, smb2_cmd_ioctl_async(s->smb, &req, receive_reply, &r), &r);
  if (!ret) *out = r.key; return ret;
}
static void put_le(uint8_t *data, uint64_t value, size_t count) { for (size_t i=0; i<count; i++) data[i]=(uint8_t)(value >> (8*i)); }
static int copy_chunk(mx_smb_session *s, const struct smb2_srv_copychunk_resume_key *key, struct mx_remote *remote,
  const struct smb2_srv_copychunk *chunk, struct smb2_srv_copychunk_reply *out, uint32_t *status) {
  uint8_t input[56] = {0}; memcpy(input, key->resume_key, 24); put_le(input+24, 1, 4);
  put_le(input+32, chunk->source_offset, 8); put_le(input+40, chunk->target_offset, 8); put_le(input+48, chunk->length, 4);
  struct smb2_ioctl_request req = {0}; req.ctl_code = SMB2_FSCTL_SRV_COPYCHUNK; req.flags = SMB2_0_IOCTL_IS_FSCTL;
  req.input_count = sizeof(input); req.input = input; req.max_output_response = 12; memcpy(req.file_id, remote->id, sizeof(req.file_id));
  struct reply r = { .kind = CHUNK }; int ret = submit(s, smb2_cmd_ioctl_async(s->smb, &req, receive_reply, &r), &r);
  *out = r.chunk; *status = r.done ? (uint32_t)r.status : 0; return ret;
}
struct held { struct mx_remote *remote; int local; struct held *next; uint32_t tree; };
static int close_all(mx_smb_session *s, struct held *held) {
  int failure = 0;
  while (held) { struct held *next = held->next;
    if (held->remote) { if (!s->broken) select_tree(s, held->tree); if (close_remote(s, held->remote)) { failure = 1; s->broken = 1; if (s->smb) { smb2_destroy_context(s->smb); s->smb = NULL; } } }
    if (held->local >= 0) close(held->local); free(held); held = next;
  }
  return failure;
}
static int hold(struct held **list, struct mx_remote *remote, int local, uint32_t tree) {
  struct held *h = calloc(1, sizeof(*h)); if (!h) return -ENOMEM;
  h->remote = remote; h->local = local; h->tree = tree; h->next = *list; *list = h; return 0;
}
static int matches(mx_smb_session *s, struct mx_remote *remote, int local, int directory) {
  struct smb2_stat_64 r = {0}; struct stat l;
  if (fstat(local, &l) || remote_stat(s, remote, &r)) return 0;
  if ((r.smb2_attributes & SMB2_FILE_ATTRIBUTE_REPARSE_POINT) || !r.smb2_ino || r.smb2_ino != l.st_ino) return 0;
  if (directory) return S_ISDIR(l.st_mode) && r.smb2_type == SMB2_TYPE_DIRECTORY;
  return S_ISREG(l.st_mode) && r.smb2_type == SMB2_TYPE_FILE && r.smb2_size == (uint64_t)l.st_size
    && r.smb2_mtime == (uint64_t)l.st_mtimespec.tv_sec && r.smb2_mtime_nsec / 1000 == (uint64_t)l.st_mtimespec.tv_nsec / 1000
    && r.smb2_btime == (uint64_t)l.st_birthtimespec.tv_sec && r.smb2_btime_nsec / 1000 == (uint64_t)l.st_birthtimespec.tv_nsec / 1000;
}
/* Lock every remote ancestor against rename/delete before matching leaf identity. Local descriptor
   traversal never follows symlinks. Unsupported inode mappings conservatively fall back. */
static int lock_parents(mx_smb_session *s, uint32_t tree, const char *root, const char *path, struct held **held, mx_smb_cancelled cancelled, void *context) {
  if (!*path || *path == '/' || strchr(path, '\\') || strchr(path, ':')) return -EINVAL;
  int local = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); if (local < 0) return -errno;
  struct mx_remote *remote = open_existing(s, tree, "", 1, 0);
  if (!remote) { close(local); return -EIO; }
  if (hold(held, remote, local, tree)) { close_remote(s, remote); close(local); return -ENOMEM; }
  char *copy = strdup(path), *acc = calloc(strlen(path) + 1, 1);
  if (!copy || !acc) { free(copy); free(acc); return -ENOMEM; }
  char *save = NULL, *name = strtok_r(copy, "/", &save); int ret = 0;
  while (name) {
    if (cancelled && cancelled(context)) { ret = -ECANCELED; break; }
    if (!strcmp(name, ".") || !strcmp(name, "..")) { ret = -EINVAL; break; }
    char *next = strtok_r(NULL, "/", &save); if (!next) break;
    if (*acc) strcat(acc, "/"); strcat(acc, name);
    int child = openat(local, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (child < 0) { ret = -errno; break; }
    remote = open_existing(s, tree, acc, 1, 0);
    if (!remote) { close(child); ret = -EIO; break; }
    if (hold(held, remote, child, tree)) { close_remote(s, remote); close(child); ret = -ENOMEM; break; }
    if (!matches(s, remote, child, 1)) { ret = -ESTALE; break; }
    local = child; name = next;
  }
  free(copy); free(acc); return ret;
}
void mx_smb_copy_metrics(mx_smb_session *s, mx_smb_metrics *metrics) { if (metrics) *metrics = s ? s->metrics : (mx_smb_metrics){0}; }
int mx_smb_copy(mx_smb_session *s, const char *source_root, const char *destination_root,
  const char *source_path, const char *destination_path, int source_fd, int destination_fd,
  mx_smb_cancelled cancelled, mx_smb_progress progress, void *context, int *error_code) {
  int result = MX_SMB_FALLBACK, code = 0, submitted = 0; struct held *held = NULL;
  struct stat from, to;
  double binding_start = monotonic_seconds(); int binding_done = 0;
  if (s) memset(&s->metrics, 0, sizeof(s->metrics));
  if (error_code) *error_code = 0;
  if (!s || s->broken || fstat(source_fd, &from) || fstat(destination_fd, &to)
    || !S_ISREG(from.st_mode) || !S_ISREG(to.st_mode) || from.st_size <= 0 || to.st_size != 0) return MX_SMB_FALLBACK;
  if (cancelled && cancelled(context)) return MX_SMB_CANCELLED;
  if (lock_parents(s, s->source_tree, source_root, source_path, &held, cancelled, context)
    || lock_parents(s, s->destination_tree, destination_root, destination_path, &held, cancelled, context)) goto out;
  if (cancelled && cancelled(context)) { result = MX_SMB_CANCELLED; goto out; }
  struct mx_remote *src = open_existing(s, s->source_tree, source_path, 0, 0);
  if (!src) goto out;
  if (hold(&held, src, -1, s->source_tree)) { close_remote(s, src); goto out; }
  if (!matches(s, src, source_fd, 0)) goto out;
  struct smb2_srv_copychunk_resume_key key = {0};
  if (request_key(s, src, &key)) goto out;
  struct mx_remote *dst = open_existing(s, s->destination_tree, destination_path, 0, 1);
  if (!dst) goto out;
  if (hold(&held, dst, -1, s->destination_tree)) { close_remote(s, dst); goto out; }
  if (!matches(s, dst, destination_fd, 0)) goto out;
  uint64_t offset = 0, total = (uint64_t)from.st_size; uint32_t maximum = 1024 * 1024; int shrunk = 0;
  s->metrics.binding_seconds = monotonic_seconds() - binding_start; binding_done = 1;
  if (progress) progress(context, 0, total);
  while (offset < total) {
    if (cancelled && cancelled(context)) { result = MX_SMB_CANCELLED; goto out; }
    uint32_t length = total - offset < maximum ? (uint32_t)(total - offset) : maximum;
    struct smb2_srv_copychunk chunk = { .source_offset = offset, .target_offset = offset, .length = length };
    struct smb2_srv_copychunk_reply reply = {0}; submitted = 1;
    uint32_t status = 0;
    double chunk_start = monotonic_seconds();
    int ret = copy_chunk(s, &key, dst, &chunk, &reply, &status);
    s->metrics.copychunk_seconds += monotonic_seconds() - chunk_start;
    if (ret) {
      if (!offset && (status == SMB2_STATUS_NOT_SUPPORTED || status == SMB2_STATUS_INVALID_DEVICE_REQUEST)) { submitted = 0; goto out; }
      if (status == SMB2_STATUS_INVALID_PARAMETER && !shrunk && reply.chunks_written > 0
        && reply.chunk_bytes_written > 0 && reply.total_bytes_written > 0) {
        uint32_t limit = reply.chunk_bytes_written < reply.total_bytes_written ? reply.chunk_bytes_written : reply.total_bytes_written;
        if (limit < length) { maximum = limit; shrunk = 1; submitted = offset != 0; continue; }
      }
      code = ret < 0 ? -ret : EIO;
      /* Only an explicit, terminal server error authorizes ordinary rollback. */
      if (status == SMB2_STATUS_DISK_FULL || status == SMB2_STATUS_ACCESS_DENIED || status == SMB2_STATUS_QUOTA_EXCEEDED)
        result = MX_SMB_FAILED;
      else { result = MX_SMB_UNCERTAIN; s->broken = 1; }
      goto out;
    }
    if (reply.chunks_written != 1 || reply.chunk_bytes_written != 0 || reply.total_bytes_written != length) {
      // The server may have written bytes despite a malformed acknowledgement.
      // Retire this session and preserve both objects; ordinary rollback is unsafe.
      code = EPROTO; result = MX_SMB_UNCERTAIN; s->broken = 1; goto out;
    }
    offset += length; s->metrics.acknowledged_bytes = offset; if (progress) progress(context, offset, total);
  }
  struct smb2_stat_64 final = {0};
  if (remote_stat(s, dst, &final) || final.smb2_size != total || final.smb2_ino != to.st_ino) {
    code = ESTALE; result = MX_SMB_FAILED; goto out;
  }
  select_tree(s, s->source_tree);
  if (!matches(s, src, source_fd, 0)) { code = ESTALE; result = MX_SMB_FAILED; goto out; }
  result = cancelled && cancelled(context) ? MX_SMB_CANCELLED : MX_SMB_COPIED;
out:
  if (!binding_done) s->metrics.binding_seconds = monotonic_seconds() - binding_start;
  double close_start = monotonic_seconds();
  if ((close_all(s, held) || s->broken) && submitted) { result = MX_SMB_UNCERTAIN; code = ECONNRESET; }
  s->metrics.closing_seconds = monotonic_seconds() - close_start;
  if (error_code) *error_code = code;
  return result;
}

int mx_smb_mount_address(int descriptor, char *host, size_t capacity, uint16_t *port) {
  struct sockaddr_storage address = {0};
  /* Apple's smbfsGetSessionSockaddrFSCTL: failure simply disables the optimization. */
  if (ffsctl(descriptor, _IOR('z', 20, struct sockaddr_storage), &address, 0)) return -1;
  if (address.ss_len > sizeof(address) || address.ss_len < sizeof(struct sockaddr)) return -1;
  if (address.ss_family != AF_INET && address.ss_family != AF_INET6) return -1;
  if (getnameinfo((struct sockaddr *)&address, address.ss_len, host, (socklen_t)capacity, NULL, 0, NI_NUMERICHOST)) return -1;
  *port = ntohs(address.ss_family == AF_INET ? ((struct sockaddr_in *)&address)->sin_port : ((struct sockaddr_in6 *)&address)->sin6_port);
  return *port ? 0 : -1;
}

/* Handle-bound deletion. Share-mode exclusion protects cooperating SMB clients;
   a server-local writer outside SMB is not covered by these locks. */
struct mx_delete_item {
  char *path; struct mx_remote *remote; mx_smb_delete_stamp expected; int listed;
  struct mx_delete_item *next;
};
struct mx_smb_deletion {
  mx_smb_session *session; struct held *parents; struct mx_delete_item *items;
  char *root; size_t count; int sealed, stopped; double deadline;
  mx_smb_cancelled cancelled; void *context;
};
static int delete_error(int *out, int code) { if (out) *out = code > 0 ? code : EIO; return MX_SMB_FAILED; }
static int safe_delete_path(const char *path) {
  if (!path || !*path || *path == '/' || strchr(path, '\\') || strchr(path, ':') || strlen(path) > 4096) return 0;
  const char *part = path;
  for (const char *p = path;; p++) {
    if ((unsigned char)*p < 32 && *p) return 0;
    if (*p == '/' || !*p) {
      size_t n = (size_t)(p - part);
      if (!n || (n == 1 && part[0] == '.') || (n == 2 && part[0] == '.' && part[1] == '.')) return 0;
      if (!*p) break; part = p + 1;
    }
  }
  return 1;
}
static int deletion_ready(mx_smb_deletion *g) {
  if (!g || g->stopped || !g->session || g->session->broken) return ENOTCONN;
  if (g->cancelled && g->cancelled(g->context)) return ECANCELED;
  if (monotonic_seconds() >= g->deadline) return ETIMEDOUT;
  return 0;
}
mx_smb_deletion *mx_smb_delete_begin(mx_smb_session *s, const char *mount_root,
  const char *root_path, mx_smb_cancelled cancelled, void *context, int *error_code) {
  if (error_code) *error_code = EINVAL;
  if (!s || !mount_root || !safe_delete_path(root_path)) return NULL;
  mx_smb_deletion *g = calloc(1, sizeof(*g)); if (!g) { if (error_code) *error_code = ENOMEM; return NULL; }
  g->session = s; g->root = strdup(root_path); g->cancelled = cancelled; g->context = context;
  g->deadline = monotonic_seconds() + 60;
  int code = g->root ? deletion_ready(g) : ENOMEM;
  if (!code) code = -lock_parents(s, s->source_tree, mount_root, root_path, &g->parents, cancelled, context);
  /* Includes the share root: a DNS alias or mismatched mount must never authorize deletion. */
  if (!code) for (struct held *h = g->parents; h; h = h->next) {
    if (!matches(s, h->remote, h->local, 1)) { code = ESTALE; break; }
  }
  if (code) { if (error_code) *error_code = code; mx_smb_delete_end(g); return NULL; }
  if (error_code) *error_code = 0; return g;
}
static int delete_stamp_matches(const mx_smb_delete_stamp *e, const struct smb2_stat_64 *r, int changed_directory) {
  if (!e->inode || !r->smb2_ino || e->inode != r->smb2_ino || (r->smb2_attributes & SMB2_FILE_ATTRIBUTE_REPARSE_POINT)) return 0;
  if ((e->type == S_IFDIR) != (r->smb2_type == SMB2_TYPE_DIRECTORY)) return 0;
  if (e->birth_seconds < 0 || e->modified_seconds < 0 || e->birth_nanos < 0 || e->birth_nanos >= 1000000000
      || e->modified_nanos < 0 || e->modified_nanos >= 1000000000) return 0;
  if ((uint64_t)e->birth_seconds != r->smb2_btime || (uint64_t)e->birth_nanos / 1000 != r->smb2_btime_nsec / 1000) return 0;
  if (changed_directory) return 1; /* Only our manifest children may have been removed. */
  return (e->type == S_IFDIR || (e->size >= 0 && (uint64_t)e->size == r->smb2_size))
    && (uint64_t)e->modified_seconds == r->smb2_mtime && (uint64_t)e->modified_nanos / 1000 == r->smb2_mtime_nsec / 1000;
}
int mx_smb_delete_bind(mx_smb_deletion *g, const char *path, const mx_smb_delete_stamp *expected, int *error_code) {
  int code = deletion_ready(g); if (code) return delete_error(error_code, code);
  if (g->sealed || !expected || !safe_delete_path(path)) return delete_error(error_code, EINVAL);
  size_t prefix = strlen(g->root);
  if (strcmp(path, g->root) && (strncmp(path, g->root, prefix) || path[prefix] != '/')) return delete_error(error_code, EPERM);
  if (!g->count && strcmp(path, g->root)) return delete_error(error_code, EPERM);
  if (strcmp(path, g->root)) {
    const char *slash = strrchr(path, '/'); size_t n = slash ? (size_t)(slash - path) : 0;
    struct mx_delete_item *parent = g->items;
    while (parent && (strlen(parent->path) != n || strncmp(parent->path, path, n))) parent = parent->next;
    if (!parent || parent->expected.type != S_IFDIR) return delete_error(error_code, EPERM);
  }
  if (g->count >= 256) return delete_error(error_code, E2BIG);
  if (expected->type != S_IFDIR && expected->type != S_IFREG) return delete_error(error_code, ENOTSUP);
  for (struct mx_delete_item *i = g->items; i; i = i->next)
    if (!strcmp(i->path, path) || i->expected.inode == expected->inode) return delete_error(error_code, ENOTSUP);
  if (select_tree(g->session, g->session->source_tree)) return delete_error(error_code, ENOTCONN);
  struct mx_delete_item *i = calloc(1, sizeof(*i));
  if (!i) return delete_error(error_code, ENOMEM);
  i->remote = calloc(1, sizeof(*i->remote)); i->path = strdup(path); i->expected = *expected;
  if (!i->remote || !i->path) { free(i->remote); free(i->path); free(i); return delete_error(error_code, ENOMEM); }
  struct smb2_create_request req = {0}; req.name = path;
  req.impersonation_level = SMB2_IMPERSONATION_IMPERSONATION;
  req.desired_access = SMB2_DELETE | SMB2_FILE_READ_ATTRIBUTES | (expected->type == S_IFDIR ? SMB2_FILE_LIST_DIRECTORY : 0);
  /* Neither writes nor rename/delete can be shared by another SMB open. */
  req.share_access = SMB2_FILE_SHARE_READ;
  req.create_disposition = SMB2_FILE_OPEN;
  req.create_options = SMB2_FILE_OPEN_REPARSE_POINT | (expected->type == S_IFDIR ? SMB2_FILE_DIRECTORY_FILE : SMB2_FILE_NON_DIRECTORY_FILE);
  struct reply r = { .kind = CREATE };
  int ret = submit(g->session, smb2_cmd_create_async(g->session->smb, &req, receive_reply, &r), &r);
  if (ret) { free(i->remote); free(i->path); free(i); return delete_error(error_code, -ret); }
  memcpy(i->remote->id, r.create.file_id, sizeof(i->remote->id));
  i->next = g->items; g->items = i; g->count++;
  struct smb2_stat_64 info = {0}; ret = remote_stat(g->session, i->remote, &info);
  if (ret) return delete_error(error_code, -ret);
  if (!delete_stamp_matches(expected, &info, 0)) return delete_error(error_code, ESTALE);
  if (error_code) *error_code = 0; return MX_SMB_COPIED;
}
static uint32_t delete_le32(const uint8_t *p) {
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}
static int direct_child(const char *parent, const char *child) {
  size_t n = strlen(parent);
  return !strncmp(parent, child, n) && child[n] == '/' && !strchr(child + n + 1, '/');
}
/* Enumerate through the retained directory handle, not the macOS metadata cache.
   Reject every extra/missing/duplicate name or changed file ID. Bound the parser and scan. */
static int verify_delete_children(mx_smb_deletion *g, struct mx_delete_item *directory) {
  for (struct mx_delete_item *i = g->items; i; i = i->next) i->listed = 0;
  int first = 1;
  for (int page = 0; page < 64; page++) {
    int code = deletion_ready(g); if (code) return code;
    struct smb2_query_directory_request req = {0}; req.file_information_class = SMB2_FILE_ID_FULL_DIRECTORY_INFORMATION;
    req.flags = first ? SMB2_RESTART_SCANS : 0; first = 0; req.name = "*"; req.output_buffer_length = 65536;
    memcpy(req.file_id, directory->remote->id, sizeof(req.file_id));
    struct reply r = { .kind = DIRECTORY };
    int ret = submit(g->session, smb2_cmd_query_directory_async(g->session->smb, &req, receive_reply, &r), &r);
    if (ret) {
      free(r.directory);
      if ((uint32_t)r.status == SMB2_STATUS_NO_MORE_FILES && !g->session->broken) {
        for (struct mx_delete_item *i = g->items; i; i = i->next)
          if (i->remote && direct_child(directory->path, i->path) && !i->listed) return ESTALE;
        return 0;
      }
      return -ret;
    }
    size_t offset = 0; int code_parse = 0;
    while (offset < r.directory_length) {
      size_t left = r.directory_length - offset;
      if (left < 80) { code_parse = EPROTO; break; }
      uint8_t *raw = r.directory + offset;
      uint32_t next = delete_le32(raw), length = delete_le32(raw + 60);
      size_t record = next ? next : left;
      if (record > left || record < 80 || length % 2 || length > record - 80 || length > 8192) { code_parse = EPROTO; break; }
      struct smb2_iovec vec = { .buf = raw, .len = record };
      struct smb2_fileidfulldirectoryinformation entry = {0};
      if (smb2_decode_fileidfulldirectoryinformation(g->session->smb, &entry, &vec) || !entry.name) { code_parse = EPROTO; break; }
      const char *name = entry.name;
      if (strcmp(name, ".") && strcmp(name, "..")) {
        size_t n = strlen(directory->path) + strlen(name) + 2;
        char *path = malloc(n);
        if (!path) { free((void *)name); code_parse = ENOMEM; break; }
        snprintf(path, n, "%s/%s", directory->path, name);
        struct mx_delete_item *matched = g->items;
        while (matched && strcmp(matched->path, path)) matched = matched->next;
        if (!safe_delete_path(name) || strchr(name, '/') || !matched || !matched->remote || matched->listed
            || !entry.file_id || entry.file_id != matched->expected.inode) code_parse = ESTALE;
        else matched->listed = 1;
        free(path);
      }
      free((void *)name);
      if (code_parse) break;
      if (!next) break;
      offset += next;
    }
    free(r.directory); if (code_parse) return code_parse;
  }
  return E2BIG;
}
int mx_smb_delete_commit(mx_smb_deletion *g, const char *path, int *error_code) {
  int code = deletion_ready(g); if (code) return delete_error(error_code, code);
  if (!g->sealed) {
    g->sealed = 1;
    // Validate the full remote manifest before the first irreversible request.
    for (struct mx_delete_item *item = g->items; item; item = item->next) {
      struct smb2_stat_64 info = {0}; int ret = remote_stat(g->session, item->remote, &info);
      if (ret || !delete_stamp_matches(&item->expected, &info, 0)) { g->stopped = 1; return delete_error(error_code, ret ? -ret : ESTALE); }
      if (item->expected.type == S_IFDIR && (code = verify_delete_children(g, item))) { g->stopped = 1; return delete_error(error_code, code); }
    }
  }
  struct mx_delete_item *i = g->items;
  while (i && strcmp(i->path, path)) i = i->next;
  if (!i || !i->remote) return delete_error(error_code, ESTALE);
  /* Postorder only: no delete-pending parent may be closed over an undeleted child. */
  for (struct mx_delete_item *child = g->items; child; child = child->next)
    if (child->remote && !strncmp(child->path, path, strlen(path)) && child->path[strlen(path)] == '/')
      return delete_error(error_code, ENOTEMPTY);
  if (select_tree(g->session, g->session->source_tree)) return delete_error(error_code, ENOTCONN);
  struct smb2_stat_64 info = {0}; int ret = remote_stat(g->session, i->remote, &info);
  if (ret) return delete_error(error_code, -ret);
  if (!delete_stamp_matches(&i->expected, &info, i->expected.type == S_IFDIR)) return delete_error(error_code, ESTALE);
  if (i->expected.type == S_IFDIR && (code = verify_delete_children(g, i))) return delete_error(error_code, code);
  if ((code = deletion_ready(g))) return delete_error(error_code, code);
  struct smb2_file_disposition_info disposition = { .delete_pending = 1 };
  struct smb2_set_info_request req = {0}; req.info_type = SMB2_0_INFO_FILE;
  req.file_info_class = SMB2_FILE_DISPOSITION_INFORMATION; req.input_data = &disposition;
  memcpy(req.file_id, i->remote->id, sizeof(req.file_id));
  struct reply r = { .kind = CLOSE };
  struct smb2_pdu *pdu = smb2_cmd_set_info_async(g->session->smb, &req, receive_reply, &r);
  if (!pdu) return delete_error(error_code, ENOMEM);
  ret = submit(g->session, pdu, &r);
  if (ret && r.done && !g->session->broken) return delete_error(error_code, -ret); /* Server refused disposition. */
  if (ret) { g->stopped = 1; if (error_code) *error_code = -ret; return MX_SMB_UNCERTAIN; }
  /* Once disposition is acknowledged, close even if cancellation arrives; report its actual result. */
  ret = close_remote(g->session, i->remote); i->remote = NULL;
  if (ret) {
    g->stopped = 1;
    if (g->session->smb) { smb2_destroy_context(g->session->smb); g->session->smb = NULL; g->session->broken = 1; }
    if (error_code) *error_code = -ret; return MX_SMB_UNCERTAIN;
  }
  if (error_code) *error_code = 0; return MX_SMB_COPIED;
}
void mx_smb_delete_end(mx_smb_deletion *g) {
  if (!g) return;
  while (g->items) {
    struct mx_delete_item *i = g->items; g->items = i->next;
    if (i->remote) {
      if (!g->session->broken) select_tree(g->session, g->session->source_tree);
      close_remote(g->session, i->remote);
    }
    free(i->path); free(i);
  }
  close_all(g->session, g->parents); free(g->root); free(g);
}
