#!/bin/zsh
set -euo pipefail
cd "${0:A:h}"

APP_PATH="$PWD/dist/mac-arm64/基金 AI 工作台.app"
if [[ ! -d "$APP_PATH" ]]; then
  "$PWD/build-desktop.command"
fi
open -na "$APP_PATH"
