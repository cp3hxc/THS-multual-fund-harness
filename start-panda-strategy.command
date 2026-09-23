#!/bin/zsh
set -e
cd "${0:A:h}"
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv --system-site-packages .venv
fi
if ! .venv/bin/python -c 'import importlib.metadata as m; assert tuple(map(int,m.version("aijijin-sdk").split(".")[:3])) >= (0,2,3)' 2>/dev/null; then
  .venv/bin/python -m pip install reference/thsfund/vendor/aijijin_sdk-0.2.3-py3-none-any.whl
fi
if [[ ! -d node_modules/electron ]]; then
  npm ci --cache .runtime/npm-cache
fi
exec npm start
