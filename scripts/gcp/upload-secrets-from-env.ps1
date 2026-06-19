# Upload .env values to Google Cloud Secret Manager (PREFIX_VAR per aappoint-api convention).
# Usage: .\scripts\gcp\upload-secrets-from-env.ps1 [-ProjectId aappoint] [-SecretPrefix dev-sui-booking] [-EnvFile .env]
param(
    [string]$ProjectId = $(if ($env:GCP_PROJECT_ID) { $env:GCP_PROJECT_ID } else { "aappoint" }),
    [string]$SecretPrefix = $(if ($env:SECRET_PREFIX) { $env:SECRET_PREFIX } else { "dev-sui-booking" }),
    [string]$EnvFile = ".env"
)

$ErrorActionPreference = "Stop"
function Test-GcpSecret([string]$SecretName, [string]$Project) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    $null = & gcloud secrets describe $SecretName --project $Project 2>&1
    $ok = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $prev
    return $ok
}

if (-not $ProjectId) {
    Write-Error "Set GCP_PROJECT_ID or pass -ProjectId"
}

if (-not (Test-Path $EnvFile)) {
    Write-Error "Env file not found: $EnvFile"
}

$manifest = Get-Content "deploy/secrets.list" | Where-Object {
    $_ -and -not $_.StartsWith("#")
}

# Parse KEY=VALUE lines (skip comments and blanks)
$envMap = @{}
Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) { return }
    $key = $line.Substring(0, $eq).Trim()
    $val = $line.Substring($eq + 1).Trim()
    if ($val.StartsWith('"') -and $val.EndsWith('"')) { $val = $val.Substring(1, $val.Length - 2) }
    $envMap[$key] = $val
}

gcloud config set project $ProjectId | Out-Null

foreach ($name in $manifest) {
    if (-not $envMap.ContainsKey($name)) {
        Write-Warning "Skip $name - not in $EnvFile"
        continue
    }
    $value = $envMap[$name].Trim()
    if ([string]::IsNullOrWhiteSpace($value)) {
        Write-Warning "Skip $name - empty value"
        continue
    }
    if ($value -match "^(your_|path/to/)") {
        Write-Warning "Skip $name - placeholder value"
        continue
    }

    $secretName = "${SecretPrefix}_$name"

    $exists = Test-GcpSecret $secretName $ProjectId

    if (-not $exists) {
        Write-Host "Creating secret: $secretName"
        gcloud secrets create $secretName --replication-policy=automatic | Out-Null
    } else {
        Write-Host "Updating secret: $secretName"
    }

    $tmpPath = Join-Path $env:TEMP "secret-upload-$secretName.txt"
    [IO.File]::WriteAllText($tmpPath, $value, (New-Object System.Text.UTF8Encoding $false))
    gcloud secrets versions add $secretName --data-file="$tmpPath" --project $ProjectId | Out-Null
    Remove-Item $tmpPath -Force -ErrorAction SilentlyContinue
}

Write-Host "`nDone. Secrets uploaded to project: $ProjectId (prefix: ${SecretPrefix}_)"
Write-Host "Next: make cloudbuild-dev  OR  push to main to trigger GitLab CI."
