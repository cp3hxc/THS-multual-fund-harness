#!/bin/zsh
set -euo pipefail
cd "${0:A:h}"

if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv --system-site-packages .venv
fi
if ! .venv/bin/python -c 'import importlib.metadata as m; assert tuple(map(int,m.version("aijijin-sdk").split(".")[:3])) >= (0,2,3)' 2>/dev/null; then
  .venv/bin/python -m pip install reference/thsfund/vendor/aijijin_sdk-0.2.3-py3-none-any.whl
fi

npm ci --cache .runtime/npm-cache
ELECTRON_VERSION=$(node -p 'require("./package.json").devDependencies.electron')
ELECTRON_ZIP=$(find "$HOME/Library/Caches/electron" -name "electron-v${ELECTRON_VERSION}-darwin-arm64.zip" -type f 2>/dev/null | head -n 1)
if [[ -n "$ELECTRON_ZIP" ]] && unzip -tqq "$ELECTRON_ZIP"; then
  ELECTRON_DIST="$PWD/.runtime/electron-dist-${ELECTRON_VERSION}-arm64"
  mkdir -p "$ELECTRON_DIST"
  unzip -q -o "$ELECTRON_ZIP" -d "$ELECTRON_DIST"
  npm run build:mac -- --publish never -c.electronDist="$ELECTRON_DIST"
else
npm run build:mac -- --publish never
fi

SOURCE_APP="$PWD/dist/mac-arm64/基金 AI 工作台.app"
TARGET_APP="/Applications/基金 AI 工作台.app"
mkdir -p "$SOURCE_APP/Contents/Resources"
python3 - "$SOURCE_APP/Contents/Resources/fund-workbench-root.json" "$PWD" <<'PY'
import json
import pathlib
import sys

pathlib.Path(sys.argv[1]).write_text(
    json.dumps({"root": str(pathlib.Path(sys.argv[2]).resolve())}, ensure_ascii=False) + "\n",
    encoding="utf-8",
)
PY
if [[ -w /Applications ]]; then
  /usr/bin/ditto "$SOURCE_APP" "$TARGET_APP"
  echo "已安装：$TARGET_APP"
else
  echo "应用已生成：$SOURCE_APP"
fi
