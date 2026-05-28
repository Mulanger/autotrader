$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$PidFile = Join-Path $Root "runtime\real-worker.pid"

if (-not (Test-Path -LiteralPath $PidFile)) {
  Write-Host "No local real worker PID file found."
  exit 0
}

$pidValue = (Get-Content -LiteralPath $PidFile -Raw).Trim()
if ($pidValue) {
  $process = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
  if ($process) {
    Stop-Process -Id ([int]$pidValue) -Force
    Write-Host "Stopped local real worker PID $pidValue."
  } else {
    Write-Host "No running process found for PID $pidValue."
  }
}

Remove-Item -LiteralPath $PidFile -Force
