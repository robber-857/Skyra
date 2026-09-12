$ErrorActionPreference = 'Stop'
# This Windows development network has no working IPv6 route to Shopify.
# Keep the IPv4 connection alive for TCP retransmission; scope this to the CLI process.
$env:NODE_OPTIONS = ($env:NODE_OPTIONS + ' --dns-result-order=ipv4first --no-network-family-autoselection').Trim()
$appPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location $appPath
try {
  & shopify.cmd app dev --path $appPath --store skyra-booking-dev.myshopify.com --theme 192227082532 --no-color
  exit $LASTEXITCODE
} finally { Pop-Location }
