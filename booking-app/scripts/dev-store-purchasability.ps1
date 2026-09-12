param([switch]$Diagnostics, [switch]$RestoreOwnership, [string]$MappingId, [switch]$RefreshSessionScopes)
$ErrorActionPreference = 'Stop'
if ($RestoreOwnership -and $MappingId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
  throw 'Ownership restoration requires one explicit MappingId UUID.'
}
if ($MappingId -and -not $RestoreOwnership) { throw 'MappingId requires RestoreOwnership.' }
$appPath = Split-Path -Parent $PSScriptRoot
$keys = @('SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET', 'SCOPES')
$previous = @{}
foreach ($key in $keys) { $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
Push-Location -LiteralPath $appPath
try {
  # Keep linked-app credentials in this process only; never print or overwrite .env.
  $appEnvironment = shopify.cmd app env show --path $appPath --no-color
  if ($LASTEXITCODE -ne 0) { throw 'Could not load the linked Shopify app environment.' }
  foreach ($line in $appEnvironment) {
    if ($line.Trim() -match '^(SHOPIFY_API_KEY|SHOPIFY_API_SECRET|SCOPES)\s*=\s*(.*)$') {
      [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim().Trim('"').Trim("'"), 'Process')
    }
  }
  if ($env:SHOPIFY_API_KEY -ne 'c9d266a38e2f11a1240139974253b3a1' -or -not $env:SHOPIFY_API_SECRET) {
    throw 'Expected the linked Skyra Booking app environment.'
  }
  $arguments = @('tsx', '--env-file=.env', 'scripts/dev-store-purchasability.ts', 'skyra-booking-dev.myshopify.com')
  if ($Diagnostics) { $arguments += '--diagnostics' }
  if ($RefreshSessionScopes) { $arguments += '--refresh-session-scopes' }
  if ($RestoreOwnership) { $arguments += "--restore-ownership=$MappingId" }
  & npx.cmd @arguments
  $result = $LASTEXITCODE
} finally {
  foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
  Pop-Location
}
exit $result
