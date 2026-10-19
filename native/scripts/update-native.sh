#!/bin/bash
# Wait outside the app process, retain the previous bundle if installation fails.
set -euo pipefail
prepared="${MAC_EXPLORER_NATIVE_PREPARED:?}"
wait_pid="${MAC_EXPLORER_NATIVE_WAIT_PID:?}"
result="${MAC_EXPLORER_NATIVE_RESULT:?}"
destination="${MAC_EXPLORER_NATIVE_INSTALL_DIR:?}/Mac Explorer Native.app"
[[ "$prepared" == /* && -d "$prepared" && ! -L "$prepared" && "$result" == /* && ! -L "$result" && "$wait_pid" =~ ^[1-9][0-9]*$ ]] || exit 1
exited=0
finish() {
  status=$?; trap - EXIT
  printf '%s\n' "$status" > "$result"
  if [[ "$exited" == 1 && "${MAC_EXPLORER_NATIVE_NO_OPEN:-0}" != 1 && -d "$destination" && ! -L "$destination" ]]; then
    identity=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$destination/Contents/Info.plist" 2>/dev/null || true)
    if [[ "$identity" == local.macexplorer.native-prototype ]]; then /usr/bin/open "$destination" || printf '2\n' > "$result"; fi
  fi
  exit "$status"
}
trap finish EXIT
for ((attempt=0; attempt<60; attempt++)); do if ! kill -0 "$wait_pid" 2>/dev/null; then exited=1; break; fi; sleep 1; done
[[ "$exited" == 1 ]] || { printf '应用未退出，已取消安装。\n' >&2; exit 1; }
MAC_EXPLORER_NATIVE_NO_OPEN=1 /bin/bash "$prepared/install-native.sh"
