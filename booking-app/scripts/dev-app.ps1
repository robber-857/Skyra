param(
  # Shopify's supported bring-your-own-tunnel URL, including its verified local proxy port.
  [string]$TunnelUrl = ''
)
$ErrorActionPreference = 'Stop'
# Keep this network workaround scoped to development child processes.
$env:NODE_OPTIONS = ($env:NODE_OPTIONS + ' --dns-result-order=ipv4first --no-network-family-autoselection').Trim()
$appPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$devArguments = @('app', 'dev', '--path', $appPath, '--store', 'skyra-booking-dev.myshopify.com', '--theme', '192227082532', '--no-color')
if ($TunnelUrl) {
  $tunnelUri = $null
  if (-not [Uri]::TryCreate($TunnelUrl, [UriKind]::Absolute, [ref]$tunnelUri) -or $tunnelUri.Scheme -ne 'https' -or $tunnelUri.UserInfo -or $tunnelUri.Query -or $tunnelUri.Fragment -or $tunnelUri.AbsolutePath -ne '/' -or $tunnelUri.Port -eq 443) {
    throw 'Use an HTTPS tunnel URL with the explicit verified local proxy port, without credentials, path, query or fragment.'
  }
  $devArguments += @('--tunnel-url', $TunnelUrl)
}
Push-Location $appPath
try {
  & shopify.cmd @devArguments
  exit $LASTEXITCODE
} finally { Pop-Location }
