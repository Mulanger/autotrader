param(
  [string]$EnvFile = ".env.local.worker",
  [switch]$ForceRestart,
  [switch]$AllowDryRun
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$EnvPath = Join-Path $Root $EnvFile

function Import-DotEnv([string]$Path) {
  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $index = $line.IndexOf("=")
    if ($index -lt 1) { continue }
    $key = $line.Substring(0, $index).Trim()
    $value = $line.Substring($index + 1).Trim()
    if (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($key, $value, "Process")
  }
}

function Is-Enabled([string]$Value) {
  return $Value -match "^(1|true|yes|on)$"
}

if (-not (Test-Path -LiteralPath $EnvPath)) {
  throw "Missing $EnvFile. Copy scripts\local-real-worker.env.example to $EnvFile and fill in the private values locally."
}

Import-DotEnv $EnvPath

if (-not $env:REAL_POLLING_ENABLED) { $env:REAL_POLLING_ENABLED = "true" }
if (-not $env:CANDIDATE_TRACKER_ENABLED) { $env:CANDIDATE_TRACKER_ENABLED = "false" }

$RuntimeDir = Join-Path $Root "runtime"
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
$PidFile = Join-Path $RuntimeDir "real-worker.pid"

if (Test-Path -LiteralPath $PidFile) {
  $existingPid = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  if ($existingPid) {
    $existing = Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue
    if ($existing) {
      if (-not $ForceRestart) {
        Write-Host "Real worker already running with PID $existingPid."
        exit 0
      }
      Stop-Process -Id ([int]$existingPid) -Force
    }
  }
  Remove-Item -LiteralPath $PidFile -Force
}

if (-not $env:DATABASE_URL) {
  throw "DATABASE_URL is required so the local worker uses the same Railway Postgres data."
}

$liveRequested = $env:REAL_TRADING_MODE -eq "live" -and (Is-Enabled $env:REAL_LIVE_TRADING_ENABLED)
if (-not $AllowDryRun -and -not $liveRequested) {
  throw "Live mode is not enabled in $EnvFile. Set REAL_TRADING_MODE=live and REAL_LIVE_TRADING_ENABLED=true, or pass -AllowDryRun."
}

if ($liveRequested) {
  $required = @("POLYMARKET_PRIVATE_KEY", "POLYMARKET_FUNDER_ADDRESS", "POLYMARKET_SIGNATURE_TYPE")
  foreach ($key in $required) {
    if (-not [Environment]::GetEnvironmentVariable($key, "Process")) {
      throw "$key is required for live local worker mode."
    }
  }
}

$geo = Invoke-RestMethod -Uri "https://polymarket.com/api/geoblock" -TimeoutSec 15
if ($geo.blocked) {
  throw "Polymarket geoblock says this PC is blocked: country=$($geo.country), region=$($geo.region). Worker not started."
}

$Node = (Get-Command node -ErrorAction Stop).Source
$OutLog = Join-Path $Root "real-worker.out.log"
$ErrLog = Join-Path $Root "real-worker.err.log"
$Process = Start-Process `
  -FilePath $Node `
  -ArgumentList @("server\real-worker.js") `
  -WorkingDirectory $Root `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog `
  -WindowStyle Hidden `
  -PassThru

Set-Content -LiteralPath $PidFile -Value $Process.Id
Write-Host "Started local real worker with PID $($Process.Id)."
Write-Host "stdout: $OutLog"
Write-Host "stderr: $ErrLog"
