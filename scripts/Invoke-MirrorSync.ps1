[CmdletBinding()]
param([ValidateRange(1, 20)][int]$Batches = 1)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$tokenPath = Join-Path $projectDirectory '.secrets/admin-token'
if (-not (Test-Path -LiteralPath $tokenPath)) { throw 'Missing .secrets/admin-token. Configure the ADMIN_TOKEN Wrangler secret and save its local copy there.' }
$token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
$headers = @{ Authorization = "Bearer $token" }
$baseUrl = 'https://download.cafe-launcher.saibamidori.com'
for ($batch = 1; $batch -le $Batches; $batch++) {
    try {
        $result = Invoke-RestMethod -Uri "$baseUrl/v1/admin/sync" -Method Post -Headers $headers -TimeoutSec 540
    } catch {
        # Fetch the sanitized status instead of printing HTTP request objects with credentials.
        try {
            $status = Invoke-RestMethod -Uri "$baseUrl/v1/admin/status" -Headers $headers -TimeoutSec 30
            $status | ConvertTo-Json -Depth 8 | Write-Output
        } catch { Write-Warning 'Could not read sync status.' }
        throw 'Mirror batch failed. Check the sanitized status above or Worker logs; the next cron will retry.'
    }
    if ($null -eq $result.PSObject.Properties['uploaded'] -or $null -eq $result.PSObject.Properties['errors']) {
        throw 'The deployed endpoint did not return a mirror sync result. Check the deployed Worker version.'
    }
    $result | ConvertTo-Json -Depth 8 | Write-Output
    if ($result.locked -or $result.errors.Count -gt 0) { throw 'Sync is locked or failed; check status before retrying.' }
    if ($result.pending.Count -eq 0) { break }
}
