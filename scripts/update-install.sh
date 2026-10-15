#!/bin/bash
# Runs independently of Electron so a running bundle is never replaced.
set -euo pipefail
prepared_update="${MAC_EXPLORER_PREPARED_UPDATE:?}"
wait_pid="${MAC_EXPLORER_WAIT_PID:?}"
destination="${MAC_EXPLORER_INSTALL_DIR:?}/Mac Explorer.app"
[[ "$prepared_update" == /* && ! -L "$prepared_update" && "$wait_pid" =~ ^[1-9][0-9]*$ ]] || exit 1
exited=0
finish() {
  status=$?
  trap - EXIT
  printf '%s\n' "$status" > "$prepared_update/result"
  # The installer restores the backup on failure; reopen whichever valid bundle remains.
  if [[ "$exited" == 1 && "${MAC_EXPLORER_NO_OPEN:-0}" != 1 && -d "$destination" && ! -L "$destination" ]]; then
    identity=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$destination/Contents/Info.plist" 2>/dev/null || true)
    if [[ "$identity" == local.macexplorer.desktop ]]; then
      if ! /usr/bin/open "$destination"; then printf '2\n' > "$prepared_update/result"; fi
    fi
  fi
  exit "$status"
}
trap finish EXIT
for ((attempt=0; attempt<60; attempt++)); do
  if ! kill -0 "$wait_pid" 2>/dev/null; then exited=1; break; fi
  sleep 1
done
[[ "$exited" == 1 ]] || { printf '应用未退出，已取消安装；原安装未作修改。\n' >&2; exit 1; }
MAC_EXPLORER_NO_OPEN=1 /bin/bash "$prepared_update/install.sh"
