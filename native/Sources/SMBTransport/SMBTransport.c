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
enum response_kind { CONNECT, TREE, CREATE, QUERY, RESUME, CHUNK, CLOSE };
struct reply {
  int done, status; enum response_kind kind; uint32_t tree;
  struct smb2_create_reply create;
  struct smb2_stat_64 stat;
  struct smb2_srv_copychunk_resume_key key;
  struct smb2_srv_copychunk_reply chunk;
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
