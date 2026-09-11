$ErrorActionPreference = 'Stop'
$themePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../shopify-theme'))
# Fixed development store/theme; never select or publish the live Horizon theme.
& shopify.cmd theme dev --store skyra-booking-dev.myshopify.com --theme 192227082532 --path $themePath --port 9292 --ignore assets/skyra.css --nodelete
exit $LASTEXITCODE
