$ErrorActionPreference = 'Stop'
# This Windows development network has no working IPv6 route to Shopify.
# Keep the IPv4 connection alive for TCP retransmission; scope this to the CLI process.
$env:NODE_OPTIONS = ($env:NODE_OPTIONS + ' --dns-result-order=ipv4first --no-network-family-autoselection').Trim()
$themePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../shopify-theme'))
# Fixed development store/theme; never select or publish the live Horizon theme.
& shopify.cmd theme dev --store skyra-booking-dev.myshopify.com --theme 192227082532 --path $themePath --port 9292 --ignore assets/skyra.css --nodelete
exit $LASTEXITCODE
