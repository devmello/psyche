# Installs psyche-node as a per-user Task Scheduler task that starts at logon (Windows box).
# Mirrors install-linux.sh (systemd user service). No administrator rights needed.
# Usage: powershell -ExecutionPolicy Bypass -File apps\node\scripts\install-windows.ps1 [-Uninstall]
#   PSYCHE_NODE_HOME   node state (default %USERPROFILE%\.psyche\node)
#   PSYCHE_REPO        checkout with node_modules installed (default: this script's repo)
#   PSYCHE_NODE_ARGS   extra flags, e.g. "--gateway ws://100.64.0.1:7979/ws"
# The task runs only while the user is logged on (an interactive, per-user task), like a systemd
# user service without lingering. Logs go to %PSYCHE_NODE_HOME%\psyche-node.log.
[CmdletBinding()]
param([switch]$Uninstall)

$ErrorActionPreference = "Stop"
$TaskName = "Psyche Node"
$TaskPath = "\Psyche\"

$Repo = if ($env:PSYCHE_REPO) { $env:PSYCHE_REPO } else { (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path }
$NodeHome = if ($env:PSYCHE_NODE_HOME) { $env:PSYCHE_NODE_HOME } else { Join-Path $env:USERPROFILE ".psyche\node" }

if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
  if ($existing) {
    Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false
  }
  Write-Output "removed task $TaskPath$TaskName (state kept in $NodeHome)"
  exit 0
}

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) { Write-Error "node (>= 24) not found on PATH"; exit 1 }
$NodeBin = $NodeCmd.Source
$Major = [int](& $NodeBin -p "process.versions.node.split('.')[0]")
if ($Major -lt 24) { Write-Error "node $Major found at $NodeBin; psyche-node needs >= 24"; exit 1 }
$TsxCli = Join-Path $Repo "node_modules\tsx\dist\cli.mjs"
if (-not (Test-Path $TsxCli)) { Write-Error "no tsx at $TsxCli (run pnpm install in $Repo)"; exit 1 }
$Main = Join-Path $Repo "apps\node\src\main.ts"

# State directory: the current user and SYSTEM only, nothing inherited (the identity key lives here;
# Windows has no 0700, so this is the equivalent of install-linux.sh's chmod).
New-Item -ItemType Directory -Force -Path $NodeHome | Out-Null
$Sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls $NodeHome /inheritance:r /grant:r "*${Sid}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" /q | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error "icacls could not restrict $NodeHome"; exit 1 }

# A small launcher so the task carries no quoting of user-supplied arguments, sets the node home
# and appends output to a log (Task Scheduler has no journal). It restarts psyche-node after a
# crash, but not after exit 78 (EX_CONFIG: revoked device, key/role or protocol mismatch) or 64
# (usage), where retrying cannot help: RestartPreventExitStatus=78 64 in the Linux unit.
$Launcher = Join-Path $NodeHome "run-psyche-node.ps1"
$Log = Join-Path $NodeHome "psyche-node.log"
$ExtraArgs = if ($env:PSYCHE_NODE_ARGS) { $env:PSYCHE_NODE_ARGS } else { "" }
@"
`$env:PSYCHE_NODE_HOME = '$($NodeHome -replace "'", "''")'
`$argv = @('$($TsxCli -replace "'", "''")', '$($Main -replace "'", "''")', 'run') + ('$($ExtraArgs -replace "'", "''")' -split '\s+' | Where-Object { `$_ -ne '' })
while (`$true) {
  & '$($NodeBin -replace "'", "''")' @argv *>> '$($Log -replace "'", "''")'
  `$code = `$LASTEXITCODE
  if (`$code -eq 0 -or `$code -eq 78 -or `$code -eq 64) { exit `$code }
  Start-Sleep -Seconds 5
}
"@ | Set-Content -Path $Launcher -Encoding UTF8

$Action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Launcher`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Action $Action -Trigger $Trigger `
  -Principal $Principal -Settings $Settings -Description "psyche-node (Psyche node agent)" -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
Write-Output "started task $TaskPath$TaskName; pairing code (if pending): Select-String code '$Log'"
