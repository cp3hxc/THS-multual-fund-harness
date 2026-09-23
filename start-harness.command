#!/bin/zsh
set -euo pipefail
cd "${0:A:h}"
./install-harness.command

if ! curl -fsS --max-time 2 http://127.0.0.1:8765/api/bootstrap >/dev/null 2>&1; then
  mkdir -p .runtime
  ./.venv/bin/python server.py >.runtime/workbench.log 2>&1 &
  echo $! >.runtime/workbench.pid
fi

DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js"
if [[ ! -f "$DSH_BIN" ]]; then
  echo "未找到 DeepSeek Harness Desktop 自带的 dsh 运行时。" >&2
  exit 1
fi
exec node "$DSH_BIN" --profile fund-workbench --port 8767
