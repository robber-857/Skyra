$ErrorActionPreference = 'Stop'
function ConvertTo-CanonicalJson($Value) {
  function Order-JsonValue($Value) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [PSCustomObject]) {
      $ordered = [ordered]@{}
      foreach ($property in ($Value.PSObject.Properties | Sort-Object Name)) {
        $ordered[$property.Name] = Order-JsonValue $property.Value
      }
      return $ordered
    }
    if ($Value -is [Array]) {
      $items = @()
      foreach ($item in $Value) { $items += ,(Order-JsonValue $item) }
      return ,$items
    }
    return $Value
  }
  return (Order-JsonValue $Value | ConvertTo-Json -Depth 100 -Compress)
}
$appPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$functionPath = Join-Path $appPath 'extensions/skyra-membership-checkout-guard'
$wasmPath = Join-Path $functionPath 'target/wasm32-unknown-unknown/release/skyra-membership-checkout-guard.wasm'
if (-not (Test-Path -LiteralPath $wasmPath)) {
  throw 'First build this Function with Shopify CLI so its official trampoline is applied.'
}
$env:SHOPIFY_CLI_NO_ANALYTICS = '1'
$cases = @()
Push-Location $appPath
try {
  $fixtures = @(Get-ChildItem -LiteralPath (Join-Path $functionPath 'tests/fixtures') -Filter '*.json' | Sort-Object Name)
  $inputs = @(Get-ChildItem -LiteralPath (Join-Path $functionPath 'tests/inputs') -Filter '*.json')
  if ($fixtures.Count -ne 11 -or $inputs.Count -ne $fixtures.Count) { throw 'Expected eleven paired Function fixtures.' }
  foreach ($fixture in $fixtures) {
    $inputPath = Join-Path $functionPath ('tests/inputs/' + $fixture.Name)
    $expected = Get-Content -LiteralPath $fixture.FullName -Raw | ConvertFrom-Json
    $input = Get-Content -LiteralPath $inputPath -Raw | ConvertFrom-Json
    if ((ConvertTo-CanonicalJson $input) -ne (ConvertTo-CanonicalJson $expected.payload.input)) {
      throw ('Input fixture mismatch: ' + $fixture.Name)
    }
    $output = & shopify.cmd app function run --config membership-test --path $functionPath --input $inputPath --json
    if ($LASTEXITCODE -ne 0) { throw ('Function runner failed: ' + $fixture.Name) }
    $result = ($output -join "`n") | ConvertFrom-Json
    if (-not $result.success -or (ConvertTo-CanonicalJson $result.output) -ne (ConvertTo-CanonicalJson $expected.payload.output)) {
      throw ('Function output mismatch: ' + $fixture.Name)
    }
    $cases += [ordered]@{ fixture = $fixture.Name; passed = $true; instructions = $result.instructions; output = $result.output }
  }
  $report = [ordered]@{
    checkedAt = [DateTime]::UtcNow.ToString('o')
    evidence = 'Local Shopify Function runner with synthetic inputs; no Shopify payment acceptance'
    wasmSha256 = (Get-FileHash -LiteralPath $wasmPath -Algorithm SHA256).Hash.ToLowerInvariant()
    passed = $cases.Count
    cases = $cases
  }
  $reportPath = Join-Path $appPath '../output/local-preview/membership-function-runtime.json'
  New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($reportPath)) -Force | Out-Null
  $report | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $reportPath -Encoding utf8
  Write-Output ('Shopify Function runner: ' + $cases.Count + '/11 passed. Report: ' + [IO.Path]::GetFullPath($reportPath))
} finally { Pop-Location }
