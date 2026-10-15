#!/bin/bash
# Install the latest official Apple Silicon release using macOS built-in tools.
set -euo pipefail

fail() { printf '安装失败：%s\n' "$*" >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || fail '目前仅支持 macOS。'
[[ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" == 1 ]] || fail '目前仅支持 Apple Silicon（M 系列芯片）。'
[[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 13 ]] || fail '需要 macOS 13 或更高版本。'
[[ "$EUID" -ne 0 ]] || fail '请使用普通用户运行，不要加 sudo。'
prepared_update="${MAC_EXPLORER_PREPARED_UPDATE:-}"
allow_unnotarized="${MAC_EXPLORER_ALLOW_UNNOTARIZED:-0}"
[[ "$allow_unnotarized" == 0 || "$allow_unnotarized" == 1 ]] || fail 'MAC_EXPLORER_ALLOW_UNNOTARIZED 只能是 0 或 1。'

repo='https://github.com/qixiaoyu27/Mac-Explorer'
install_dir="${MAC_EXPLORER_INSTALL_DIR:-/Applications}"
[[ "$install_dir" == /* ]] || fail '安装目录必须是绝对路径。'
mkdir -p "$install_dir"
[[ -w "$install_dir" ]] || fail "无法写入 $install_dir，请选择可写目录后重试。"
destination="$install_dir/Mac Explorer.app"
[[ ! -L "$destination" ]] || fail '目标应用是符号链接，请先自行检查。'
existing="$destination"
legacy_app="$HOME/Applications/Mac Explorer.app"
if [[ "$install_dir" == /Applications && ! -e "$destination" && ( -e "$legacy_app" || -L "$legacy_app" ) ]]; then
  existing="$legacy_app"
fi
[[ ! -L "$existing" ]] || fail '已有应用是符号链接，请先自行检查。'
if [[ -e "$existing" ]]; then
  identity=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$existing/Contents/Info.plist" 2>/dev/null || true)
  [[ "$identity" == local.macexplorer.desktop ]] || fail '目标位置存在其他应用，未作修改。'
fi
app_running() { pgrep -f '/Mac Explorer[.]app/Contents/MacOS/Mac Explorer($| )' >/dev/null; }
relocate_existing() {
  [[ "$existing" != "$destination" ]] || return 0
  app_running && fail '请先退出 Mac Explorer，再重新运行此命令完成迁移。'
  [[ ! -e "$destination" && ! -L "$destination" ]] || fail '目标位置已出现其他应用，原安装未作修改。'
  mv "$existing" "$destination"
  printf '已移至应用程序：%s\n' "$destination"
}

work=$(mktemp -d "${TMPDIR:-/tmp}/mac-explorer-download.XXXXXX")
stage=''
backup=''
installed=0
download_pid=''
cleanup() {
  status=$?
  if [[ -n "$download_pid" ]]; then kill "$download_pid" 2>/dev/null || true; wait "$download_pid" 2>/dev/null || true; fi
  if [[ "$installed" == 0 && -n "$backup" && ! -e "$existing" && ! -L "$existing" && -d "$backup" ]]; then
    mv "$backup" "$existing" || printf '旧版本保留在：%s\n' "$backup" >&2
  fi
  # A failed restoration must leave the temporary old app available for recovery.
  if [[ -n "$stage" && ( "$installed" == 1 || -z "$backup" || ! -e "$backup" ) ]]; then rm -rf "$stage"; fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fetch() { curl --fail --location --silent --show-error --retry 2 --connect-timeout 15 --max-time 600 --proto '=https' --tlsv1.2 "$1" -o "$2"; }

# Compare numeric release components; never replace a newer local build.
version_compare() {
  awk -v local_version="$1" -v remote_version="$2" 'BEGIN {
    split(local_version,a,"."); split(remote_version,b,".");
    for(i=1;i<=3;i++) { if(a[i]+0>b[i]+0) {print 1;exit} if(a[i]+0<b[i]+0) {print -1;exit} }
    print 0
  }'
}
show_progress() {
  local current total line
  current=$(stat -f%z "$work/$archive" 2>/dev/null || printf 0)
  # Redirects and retries may append multiple responses. Only use the last one's length.
  total=$(awk 'toupper($1) ~ /^HTTP\// {n=0} tolower($1)=="content-length:" {gsub("\r","",$2);n=$2} END {print n+0}' "$work/headers")
  line=$(awk -v n="$current" -v total="$total" -v done="$1" 'BEGIN {
    if(done) total=n;
    if(total>0) {p=100*n/total;if(!done && p>99)p=99;printf "【%.2f MiB】/【%.2f MiB】   【%.0f%%】", n/1048576,total/1048576,p}
    else printf "【%.2f MiB】/【总大小待确认】   【--%%】", n/1048576
  }')
  if [[ -t 1 ]]; then printf '\r%s\033[K' "$line"; else printf '%s\n' "$line"; fi
}
download_archive() {
  : > "$work/headers"
  curl --fail --location --silent --show-error --retry 2 --connect-timeout 15 --max-time 600 --proto '=https' --tlsv1.2 --dump-header "$work/headers" "$1" -o "$work/$archive" &
  download_pid=$!
  local tick=0
  while kill -0 "$download_pid" 2>/dev/null; do
    if [[ -t 1 || $((tick % 5)) == 0 ]]; then show_progress 0; fi
    sleep 1
    tick=$((tick + 1))
  done
  if ! wait "$download_pid"; then
    download_pid=''
    printf '\n' >&2
    fail '下载未完成，请检查网络后重试；原安装未作修改。'
  fi
  download_pid=''
  show_progress 1
  [[ ! -t 1 ]] || printf '\n'
}

printf '正在查询最新版…\n'
if [[ -n "$prepared_update" ]]; then
  [[ "$prepared_update" == /* && -d "$prepared_update" && ! -L "$prepared_update" ]] || fail '无效的更新目录。'
  cp "$prepared_update/SHA256SUMS.txt" "$work/checksums"
else
  fetch "$repo/releases/latest/download/SHA256SUMS.txt" "$work/checksums"
fi
entry=$(awk 'length($1)==64 && $1 !~ /[^[:xdigit:]]/ && $2 ~ /^Mac-Explorer-[0-9]+\.[0-9]+\.[0-9]+-mac-arm64\.zip$/ { print $1 " " $2 }' "$work/checksums")
[[ -n "$entry" && "$entry" != *$'\n'* ]] || fail '发布校验文件格式不正确。'
expected=${entry%% *}
archive=${entry#* }
version=${archive#Mac-Explorer-}
version=${version%-mac-arm64.zip}
if [[ -e "$existing" ]]; then
  current_version=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$existing/Contents/Info.plist" 2>/dev/null || true)
  [[ "$current_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail '无法识别已安装版本，未作修改。'
  printf '已安装：v%s · 最新版：v%s\n' "$current_version" "$version"
  comparison=$(version_compare "$current_version" "$version")
  if [[ "$comparison" == 0 ]]; then relocate_existing; printf '已是最新版，无需下载安装。\n'; exit 0; fi
  if [[ "$comparison" == 1 ]]; then relocate_existing; printf '本地版本较新，保留当前安装，不降级。\n'; exit 0; fi
  printf '发现新版本，准备更新…\n'
fi
app_running && fail '请先退出 Mac Explorer，再重新运行此命令完成更新。'
printf '正在下载 Mac Explorer %s…\n' "$version"
# Pin the ZIP to the version selected from the checksum file, even during a new release.
if [[ -n "$prepared_update" ]]; then
  cp "$prepared_update/$archive" "$work/$archive"
else
  download_archive "$repo/releases/download/v$version/$archive"
fi
actual=$(shasum -a 256 "$work/$archive" | awk '{print $1}')
[[ "$actual" == "$expected" ]] || fail '下载校验不一致，原安装未作修改。'
printf '校验通过，正在准备安装…\n'
ditto -x -k "$work/$archive" "$work/unpacked"
source_app="$work/unpacked/Mac Explorer.app"
[[ -d "$source_app" && ! -L "$source_app" ]] || fail '安装包中缺少应用。'
[[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$source_app/Contents/Info.plist")" == local.macexplorer.desktop ]] || fail '应用标识不匹配。'
[[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$source_app/Contents/Info.plist")" == "$version" ]] || fail '应用版本不匹配。'
codesign --verify --deep --strict "$source_app"
stage=$(mktemp -d "$install_dir/.mac-explorer-install.XXXXXX")
ditto "$source_app" "$stage/Mac Explorer.app"
codesign --verify --deep --strict "$stage/Mac Explorer.app"
if [[ "$allow_unnotarized" == 1 ]]; then
  printf '按你的选择，仅移除已校验 Mac Explorer 的下载隔离标记；不更改系统安全设置。\n'
  # -s acts on symlinks themselves, never on targets outside the staged bundle.
  /usr/bin/xattr -drs com.apple.quarantine "$stage/Mac Explorer.app" || fail '无法移除应用隔离标记，原安装未作修改。'
  codesign --verify --deep --strict "$stage/Mac Explorer.app"
fi
app_running && fail '下载期间应用被打开，请先退出后重试。'
if [[ "$existing" != "$destination" && ( -e "$destination" || -L "$destination" ) ]]; then
  fail '目标位置已出现其他应用，原安装未作修改。'
fi
if [[ -e "$existing" ]]; then
  backup="$stage/previous.app"
  mv "$existing" "$backup"
fi
mv "$stage/Mac Explorer.app" "$destination"
installed=1
launch_message='可从应用程序目录打开'
if [[ "${MAC_EXPLORER_NO_OPEN:-0}" != 1 ]]; then
  if open "$destination"; then launch_message='已请求启动应用'; else launch_message='请从应用程序目录手动打开'; fi
fi

show_completion() {
  local title='' success='' muted='' accent='' reset=''
  if [[ -t 1 && "${TERM:-dumb}" != dumb && -z "${NO_COLOR+x}" ]]; then
    title=$'\033[1;36m'; success=$'\033[1;32m'; muted=$'\033[2m'; accent=$'\033[1;33m'; reset=$'\033[0m'
  fi
  # An open right edge keeps full paths/URLs copyable without padding or clipping.
  printf '\n  %s╭─ MAC EXPLORER ─────────────────%s\n' "$title" "$reset"
  printf '  %s│%s\n' "$muted" "$reset"
  printf '  %s│%s  %s✓ 安装完成%s  v%s\n' "$muted" "$reset" "$success" "$reset" "$version"
  printf '  %s│%s  %s\n' "$muted" "$reset" "$launch_message"
  printf '  %s│%s\n' "$muted" "$reset"
  printf '  %s│  安装位置%s\n' "$muted" "$reset"
  printf '  %s│%s  %s\n' "$muted" "$reset" "$destination"
  printf '  %s│%s\n' "$muted" "$reset"
  printf '  %s├───────────────────────────────%s\n' "$muted" "$reset"
  printf '  %s│%s\n' "$muted" "$reset"
  printf '  %s│%s  %s⭐ Star · 支持 Mac Explorer%s\n' "$muted" "$reset" "$accent" "$reset"
  printf '  %s│%s  用 Mac 更顺手了？点亮一颗星，支持持续更新。\n' "$muted" "$reset"
  printf '  %s│%s  %s\n' "$muted" "$reset" "$repo"
  printf '  %s│%s\n' "$muted" "$reset"
  printf '  %s╰───────────────────────────────%s\n\n' "$title" "$reset"
  printf '  %s临时签名 · 未经 Apple 公证；若系统拦截，请查看安装说明。%s\n' "$muted" "$reset"
  printf '  %s#下载与安装\n\n' "$repo"
}
show_completion
