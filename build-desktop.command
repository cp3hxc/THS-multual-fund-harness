#!/bin/zsh
set -euo pipefail
cd "${0:A:h}"
npm run build:mac
