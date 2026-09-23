#!/bin/zsh
set -euo pipefail
cd "${0:A:h}"

if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv --system-site-packages .venv
fi
if ! .venv/bin/python -c 'import importlib.metadata as m; assert tuple(map(int,m.version("aijijin-sdk").split(".")[:3])) >= (0,2,3)' 2>/dev/null; then
  .venv/bin/python -m pip install reference/thsfund/vendor/aijijin_sdk-0.2.3-py3-none-any.whl
fi

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PRESET_DIR="$DSH_HOME_DIR/.agent-presets/fund-workbench"
SKILL_DIR="$DSH_HOME_DIR/skills/fund-workbench"
PROFILE_DIR="$DSH_HOME_DIR/profiles/fund-workbench"

mkdir -p "$PRESET_DIR" "$SKILL_DIR" "$PROFILE_DIR"
python3 - "$PWD/harness/agent-preset/fund-workbench/agent.cordis.yml" "$PRESET_DIR/agent.cordis.yml" "$PWD" <<'PY'
import json
import pathlib
import sys

source, destination, root = map(pathlib.Path, sys.argv[1:])
text = source.read_text(encoding="utf-8")
values = {
    "__FUND_WORKBENCH_PYTHON__": str(root / ".venv/bin/python"),
    "__FUND_WORKBENCH_MCP_SERVER__": str(root / "harness/mcp_server.py"),
    "__FUND_WORKBENCH_ROOT__": str(root),
}
for marker, value in values.items():
    text = text.replace(marker, json.dumps(value))
destination.write_text(text, encoding="utf-8")
PY
cp harness/agent-preset/fund-workbench/preset.yml "$PRESET_DIR/preset.yml"
cp harness/skills/fund-workbench/SKILL.md "$SKILL_DIR/SKILL.md"
cp harness/profile/package.json "$PROFILE_DIR/package.json"
cp harness/profile/cordis.patch.yml "$PROFILE_DIR/cordis.patch.yml"
chmod 700 "$PRESET_DIR" "$SKILL_DIR" "$PROFILE_DIR"
chmod 600 "$PRESET_DIR"/* "$SKILL_DIR"/* "$PROFILE_DIR"/*
chmod +x harness/mcp_server.py harness/fund_tool.py
echo "已安装 DeepSeek Harness 模式：场外基金工作台"
echo "工作区：$PWD"
echo "个人扶摇密钥和同花顺授权不会被此脚本复制或上传。"
