$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'lifecycle.mjs') 'pro' @args
exit $LASTEXITCODE
