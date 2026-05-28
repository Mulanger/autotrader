param(
  [string]$TaskName = "Autotrader Real Worker",
  [string]$EnvFile = ".env.local.worker"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$StartScript = Join-Path $ScriptDir "start-local-real-worker.ps1"

if (-not (Test-Path -LiteralPath (Join-Path $Root $EnvFile))) {
  throw "Missing $EnvFile. Create it before installing the startup task."
}

$PowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$StartScript`" -EnvFile `"$EnvFile`""
$Action = New-ScheduledTaskAction -Execute $PowerShell -Argument $Arguments -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 365) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
Write-Host "Installed scheduled task '$TaskName'. It will start the local real worker when you log in."
