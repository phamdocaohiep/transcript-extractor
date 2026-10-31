$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'lifecycle.mjs') 'pub-dev' @args
exit $LASTEXITCODE
