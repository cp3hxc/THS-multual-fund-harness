$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
node scripts/run.js desktop
exit $LASTEXITCODE
