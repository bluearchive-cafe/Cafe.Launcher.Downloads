[CmdletBinding()]
param([switch]$SummaryOnly)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$tokenPath = Join-Path $projectDirectory '.secrets/admin-token'
if (-not (Test-Path -LiteralPath $tokenPath)) { throw 'Missing local administrator token in .secrets/admin-token.' }
$headers = @{ Authorization = 'Bearer ' + (Get-Content -LiteralPath $tokenPath -Raw).Trim() }
try {
    $result = Invoke-RestMethod -Uri 'https://cafe-launcher-downloads.gytxtx.workers.dev/admin/stats' -Headers $headers -TimeoutSec 30
} catch { throw 'Could not read mirror statistics. Check the deployed Worker and administrator token.' }
if ($SummaryOnly) { $result.summary | ConvertTo-Json } else { $result | ConvertTo-Json -Depth 8 }
