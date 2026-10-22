#ifndef MAC_EXPLORER_SMB_H
#define MAC_EXPLORER_SMB_H
#include <stdint.h>
#include <stddef.h>

typedef struct mx_smb_session mx_smb_session;
typedef int (*mx_smb_cancelled)(void *);
typedef void (*mx_smb_progress)(void *, uint64_t, uint64_t);
enum { MX_SMB_COPIED = 0, MX_SMB_FALLBACK = 1, MX_SMB_FAILED = 2,
       MX_SMB_UNCERTAIN = 3, MX_SMB_CANCELLED = 4 };
/* Credentials never appear in argv, logs, or error strings. The caller owns the password. */
mx_smb_session *mx_smb_connect(const char *server, const char *source_share,
  const char *destination_share, const char *user, const char *domain,
  const char *password, int require_encryption, int *error_code);
void mx_smb_destroy(mx_smb_session *session);
/* Last copy's monotonic timings and counts; no paths, content, or credentials. */
typedef struct {
  double binding_seconds, copychunk_seconds, closing_seconds;
  uint64_t request_count, acknowledged_bytes;
} mx_smb_metrics;
void mx_smb_copy_metrics(mx_smb_session *session, mx_smb_metrics *metrics);
/* Read-only endpoint of an already mounted SMB session; no credentials or file content. */
int mx_smb_mount_address(int descriptor, char *host, size_t capacity, uint16_t *port);
/* Both files must already exist and be held by the caller; this never creates/truncates a remote path.
   FALLBACK guarantees that no COPYCHUNK was accepted or remains in flight.
   UNCERTAIN forbids local cleanup: the server may still be processing a request. */
int mx_smb_copy(mx_smb_session *session, const char *source_root, const char *destination_root,
  const char *source_path, const char *destination_path, int source_fd, int destination_fd,
  mx_smb_cancelled cancelled, mx_smb_progress progress, void *context, int *error_code);
#endif
