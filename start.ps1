$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
node scripts/run.js web
exit $LASTEXITCODE
