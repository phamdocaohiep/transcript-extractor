$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'lifecycle.mjs') 'pub-pro' @args
exit $LASTEXITCODE
