<#
.SYNOPSIS
  Install a locally built Psyche for this Windows user (the counterpart of deploy/macos/install-local.sh).

.DESCRIPTION
    powershell -File deploy\windows\install-local.ps1                      # newest dist\Psyche-*-Setup.exe
    powershell -File deploy\windows\install-local.ps1 dist\Psyche-0.3.0-Setup.exe
    pnpm app:install [setup.exe] [--keep-data] [--no-launch] [--dry-run]

  What it does: quits a running Psyche, ends the Gateway task (\Psyche\Gateway) and its processes so
  nothing runs from the old install, RESETS the app (every bit of data and cache, so the new build
  starts from scratch: $PSYCHE_HOME (~\.psyche: state, vault, workspace, logs, backups), the desktop's
  %APPDATA%\Psyche (settings, web storage, caches, logs, crash dumps), the Gateway's and helper's
  per-user caches, the scheduled task and the Credential Manager entries the vault and helper keep),
  runs the Squirrel installer silently (per user, %LOCALAPPDATA%\Psyche), reports its Authenticode
  signature, and launches the new app, which registers the Gateway task again and runs first-run
  onboarding. -KeepData installs over the existing data instead (only the processes are stopped).
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)] [string] $Source,
  [switch] $KeepData,
  [switch] $NoLaunch,
  [switch] $DryRun
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Task = "\Psyche\Gateway"
$InstallRoot = Join-Path $env:LOCALAPPDATA "Psyche"

function Say([string] $m) { Write-Host "==> $m" }
function Act([string] $what, [scriptblock] $do) {
  if ($DryRun) { Write-Host "    (dry run) $what" } else { & $do }
}
# Runs a native tool quietly and returns its exit code. Windows PowerShell 5.1 turns a native
# command's stderr into a terminating error under ErrorActionPreference=Stop, so not in here.
function Quiet([string] $cmd, [string[]] $argv) {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $cmd @argv *> $null; return $LASTEXITCODE } finally { $ErrorActionPreference = $saved }
}

if ($env:OS -ne "Windows_NT") { throw "install-local.ps1 runs on Windows" }

# 1. The installer: an explicit path, or the newest one in dist\.
if (-not $Source) {
  $newest = Get-ChildItem (Join-Path $Root "dist") -Filter "Psyche-*-Setup.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($newest) { $Source = $newest.FullName }
}
if (-not $Source -or -not (Test-Path $Source)) {
  throw "nothing to install: no dist\Psyche-*-Setup.exe (run pnpm app:build first)"
}
$Source = (Resolve-Path $Source).Path
if ($Source -notmatch '-Setup\.exe$') { throw "source must be a Psyche-<version>-Setup.exe: $Source" }
$old = Get-ChildItem $InstallRoot -Directory -Filter "app-*" -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending | Select-Object -First 1
if ($old) { Say "Replacing Psyche $($old.Name.Substring(4)) with $(Split-Path $Source -Leaf)" }
else { Say "Installing $(Split-Path $Source -Leaf)" }

$PsycheHome = if ($env:PSYCHE_HOME) { $env:PSYCHE_HOME } else { Join-Path $env:USERPROFILE ".psyche" }

# 2. Stop what runs from the old install: the app, the Gateway task and its service host tree
#    (schtasks /End only ends conhost), the helper.
$running = Get-Process -Name "Psyche" -ErrorAction SilentlyContinue
if ($running) {
  Say "Quitting Psyche"
  Act "close Psyche" {
    $running | ForEach-Object { [void] $_.CloseMainWindow() }
    for ($i = 0; $i -lt 20 -and (Get-Process -Name "Psyche" -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
    if (Get-Process -Name "Psyche" -ErrorAction SilentlyContinue) {
      Say "Psyche did not quit; stopping it"
      Stop-Process -Name "Psyche" -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
    }
  }
}
$hasTask = ((Quiet schtasks.exe @("/Query", "/TN", $Task)) -eq 0)
if ($hasTask) {
  Say "Stopping the Gateway task ($Task)"
  Act "schtasks /End /TN $Task" { [void] (Quiet schtasks.exe @("/End", "/TN", $Task)) }
}
foreach ($f in @("gateway-service.pid", "gateway.pid")) {
  $pidFile = Join-Path $PsycheHome "run\$f"
  if (Test-Path $pidFile) {
    $procId = (Get-Content $pidFile -Raw).Trim()
    if ($procId -match '^\d+$' -and (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
      Act "taskkill /PID $procId /T /F" { [void] (Quiet taskkill.exe @("/PID", $procId, "/T", "/F")) }
    }
  }
}
Get-Process -Name "psyche-helper", "node" -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($InstallRoot, [StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object {
    Say "Stopping $($_.Name) ($($_.Id)) from the old install"
    $p = $_
    Act "stop $($p.Name) $($p.Id)" { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  }

# 3. Reset: everything the app, the Gateway and the helper keep for this user, so the new build runs
#    first-run onboarding on a clean slate.
if (-not $KeepData) {
  $resolvedHome = [IO.Path]::GetFullPath($PsycheHome).TrimEnd('\')
  $profileDir = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')
  if ($resolvedHome -eq $profileDir -or $resolvedHome.Length -le 3) {
    throw "refusing to delete $PsycheHome as PSYCHE_HOME"
  }
  Say "Resetting app data and caches (pass -KeepData to install over them)"
  $paths = @(
    $resolvedHome,
    (Join-Path $env:APPDATA "Psyche"),
    (Join-Path $env:LOCALAPPDATA "com.psyche.gateway"),
    (Join-Path $env:APPDATA "com.psyche.helper"),
    (Join-Path $env:LOCALAPPDATA "com.psyche.helper"),
    (Join-Path $env:LOCALAPPDATA "Psyche Helper")
  )
  foreach ($p in $paths) {
    if (Test-Path $p) {
      Write-Host "    removing $p"
      Act "remove $p" { Remove-Item -LiteralPath $p -Recurse -Force }
    }
  }
  if ($hasTask) {
    Write-Host "    removing the scheduled task $Task"
    Act "schtasks /Delete /TN $Task /F" { [void] (Quiet schtasks.exe @("/Delete", "/TN", $Task, "/F")) }
  }
  # Credential Manager: the vault's key and the helper's stores (generic credentials whose target
  # starts with com.psyche.).
  $targets = @(& cmdkey.exe /list | ForEach-Object {
    if ($_ -match 'target=(com\.psyche\.[^\s]+)') { $Matches[1] }
  } | Sort-Object -Unique)
  foreach ($t in $targets) {
    Write-Host "    removing credential $t"
    Act "cmdkey /delete:$t" { [void] (Quiet cmdkey.exe @("/delete:$t")) }
  }
}

# 4. Install: Squirrel's Setup.exe installs per user without a prompt, runs the app's
#    --squirrel-install hook (shortcuts, the helper's toast activator) and starts the app.
Say "Running $(Split-Path $Source -Leaf) --silent"
Act "$Source --silent" {
  $p = Start-Process -FilePath $Source -ArgumentList "--silent" -PassThru -Wait
  if ($p.ExitCode -ne 0) { throw "the installer exited $($p.ExitCode) (log: $InstallRoot\SquirrelSetup.log)" }
}
if (-not $DryRun) {
  $exe = Join-Path $InstallRoot "Psyche.exe"
  $current = Get-ChildItem $InstallRoot -Directory -Filter "app-*" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not (Test-Path $exe) -or -not $current) { throw "the installer left no $exe" }
  $sig = Get-AuthenticodeSignature (Join-Path $current.FullName "Psyche.exe")
  $who = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { "no signer" }
  Say "Installed Psyche $($current.Name.Substring(4)) in $InstallRoot (signature: $($sig.Status), $who)"
}

# 5. Squirrel starts the app after a first install; start it when it is not running (an update over
#    an existing install), or stop it for -NoLaunch.
if ($NoLaunch) {
  Act "stop the app Squirrel started" {
    Start-Sleep -Seconds 2
    Stop-Process -Name "Psyche" -Force -ErrorAction SilentlyContinue
  }
} else {
  Act "start Psyche" {
    Start-Sleep -Seconds 2
    if (-not (Get-Process -Name "Psyche" -ErrorAction SilentlyContinue)) {
      Say "Launching"
      Start-Process (Join-Path $InstallRoot "Psyche.exe")
    } else {
      Say "Psyche is running"
    }
  }
}
