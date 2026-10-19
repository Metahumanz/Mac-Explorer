#!/bin/bash
# Keep the public installer entry point while using the native release installer.
set -euo pipefail
installer=$(mktemp "${TMPDIR:-/tmp}/mac-explorer-installer.XXXXXX")
trap 'rm -f "$installer"' EXIT
curl --fail --location --silent --show-error --retry 2 --connect-timeout 15 --max-time 120 --proto '=https' --proto-redir '=https' --tlsv1.2 \
  https://raw.githubusercontent.com/qixiaoyu27/Mac-Explorer/refs/tags/v1.1.0/native/scripts/install-native.sh -o "$installer"
/bin/bash "$installer"
