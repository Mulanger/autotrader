$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$PidFile = Join-Path $Root "runtime\real-worker.pid"
$OutLog = Join-Path $Root "real-worker.out.log"
$ErrLog = Join-Path $Root "real-worker.err.log"

if (-not (Test-Path -LiteralPath $PidFile)) {
  Write-Host "Local real worker is not running; no PID file exists."
  exit 0
}

$pidValue = (Get-Content -LiteralPath $PidFile -Raw).Trim()
$process = $null
if ($pidValue) {
  $process = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
}

if ($process) {
  Write-Host "Local real worker running with PID $pidValue."
  Write-Host "Started: $($process.StartTime)"
} else {
  Write-Host "PID file exists, but process $pidValue is not running."
}

if (Test-Path -LiteralPath $OutLog) {
  Write-Host ""
  Write-Host "Last stdout lines:"
  Get-Content -LiteralPath $OutLog -Tail 10
}

if (Test-Path -LiteralPath $ErrLog) {
  Write-Host ""
  Write-Host "Last stderr lines:"
  Get-Content -LiteralPath $ErrLog -Tail 10
}
