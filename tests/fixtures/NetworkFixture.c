#include <CoreFoundation/CoreFoundation.h>
#include <NetFS/NetFS.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int mountFixture(CFURLRef url, CFURLRef mountpath, CFStringRef user, CFStringRef password,
                       CFMutableDictionaryRef openOptions, CFMutableDictionaryRef mountOptions, CFArrayRef *mounts) {
  const char *mode = getenv("EXPLORER_FIXTURE_NETWORK_MODE");
  if (mode && strcmp(mode, "cancel") == 0) return -128;
  if (mode && strcmp(mode, "error") == 0) return EACCES;
  if (mode && strcmp(mode, "empty") == 0) return 0;
  if (mode && strcmp(mode, "delay") == 0) usleep(500000);
  const char *output = getenv("EXPLORER_FIXTURE_NETWORK_LOG");
  char address[8192];
  if (output && CFStringGetCString(CFURLGetString(url), address, sizeof(address), kCFStringEncodingUTF8)) {
    FILE *log = fopen(output, "w");
    if (log) { fputs(address, log); fclose(log); }
  }
  const char *path = getenv("EXPLORER_FIXTURE_MOUNT_PATH");
  if (!path) return EINVAL;
  CFStringRef item = CFStringCreateWithCString(NULL, path, kCFStringEncodingUTF8);
  *mounts = CFArrayCreate(NULL, (const void **)&item, 1, &kCFTypeArrayCallBacks);
  CFRelease(item);
  return 0;
}

__attribute__((used, section("__DATA,__interpose")))
static const struct { const void *replacement; const void *original; } mountInterpose = {
  (const void *)&mountFixture, (const void *)&NetFSMountURLSync
};
