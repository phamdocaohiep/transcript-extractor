$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'lifecycle.mjs') 'dev' @args
exit $LASTEXITCODE
