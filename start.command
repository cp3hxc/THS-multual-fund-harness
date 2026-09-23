#!/bin/zsh
set -e
cd "${0:A:h}"
exec node scripts/run.js web
