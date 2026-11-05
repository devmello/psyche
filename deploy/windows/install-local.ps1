<#
.SYNOPSIS
  Install a locally built Psyche for this Windows user (the counterpart of deploy/macos/install-local.sh).

.DESCRIPTION
    powershell -File deploy\windows\install-local.ps1                      # newest dist\Psyche-*-Setup.exe
    powershell -File deploy\windows\install-local.ps1 dist\Psyche-0.3.0-Setup.exe
    pnpm app:install [setup.exe] [--reset [--yes]] [--no-launch] [--dry-run]

  What it does: quits a running Psyche, ends the Gateway task (\Psyche\Gateway-<your SID>, and the
  shared \Psyche\Gateway of earlier versions when it is yours) and its processes so nothing runs
  from the old install, runs the Squirrel installer silently (per user, %LOCALAPPDATA%\Psyche),
  reports its Authenticode signature, and launches the new app, which registers the Gateway task
  again. YOUR DATA IS KEPT by default ($PSYCHE_HOME, usually ~\.psyche, the desktop's
  %APPDATA%\Psyche, the helper's folders and the Credential Manager items are not touched).
  -KeepData is accepted and does nothing (it is the default).

  -Reset instead wipes every bit of data and cache so the new build starts from scratch and runs
  first-run onboarding: $PSYCHE_HOME (~\.psyche: state, vault, workspace, logs, backups), the
  desktop's %APPDATA%\Psyche, the Gateway's and helper's per-user folders, the sandbox PC's guest
  image, the Gateway scheduled task and the Credential Manager items whose target starts with
  Psyche/. It prints exactly what it will delete (permanently, not to the Recycle Bin) and asks you
  to type RESET first; -Yes (alias -Force) skips the question, and without a terminal -Reset
  refuses unless -Yes is given. The data folder is the one the installed Gateway task runs with (a
  PSYCHE_HOME that differs is a warning); it must be a Psyche folder strictly inside your user
  folder, and -Yes is refused for any folder other than the default ~\.psyche. A path that cannot
  be removed is reported at the end; the rest still goes. The sandbox PC service needs an
  administrator to remove and is left alone (docs/guides/install.md, "Uninstall on Windows").

  -DryRun changes nothing and prints what would happen.

  Test overrides (never needed on a real PC): USERPROFILE, APPDATA, LOCALAPPDATA and PSYCHE_HOME
  move the folders this reads and wipes, and PSYCHE_TEST_TASK names a task that does not exist.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)] [string] $Source,
  [switch] $KeepData,
  [switch] $Reset,
  [Alias("Force")] [switch] $Yes,
  [switch] $NoLaunch,
  [switch] $DryRun
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$InstallRoot = Join-Path $env:LOCALAPPDATA "Psyche"
# The Gateway task is per account (Task Scheduler names are machine-wide): <folder><prefix><SID>,
# from the definition the app and the CLI use (packages/hostfs/src/gateway-task.ts).
$TaskSpec = Get-Content (Join-Path $Root "packages\hostfs\src\gateway-task.json") -Raw | ConvertFrom-Json
$Me = [Security.Principal.WindowsIdentity]::GetCurrent()
$Task = "$($TaskSpec.folder)$($TaskSpec.prefix)$($Me.User.Value)"
$LegacyTask = "$($TaskSpec.folder)$($TaskSpec.legacyName)"
# A test names a task that does not exist, so a run never reads or ends the real one.
if ($env:PSYCHE_TEST_TASK) { $Task = $env:PSYCHE_TEST_TASK; $LegacyTask = "$($env:PSYCHE_TEST_TASK)-legacy" }

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
# Runs a native tool and returns its output lines (empty when it fails).
function Capture([string] $cmd, [string[]] $argv) {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = @(& $cmd @argv 2> $null)
    if ($LASTEXITCODE -ne 0) { return @() }
    return $out
  } finally { $ErrorActionPreference = $saved }
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

# The Gateway tasks that exist for this account. The shared \Psyche\Gateway of an earlier version
# counts when it runs as this account (its logon trigger names our SID, or its principal our
# DOMAIN\user); another account's is left alone.
function Test-OwnLegacyTask {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { $xml = (& schtasks.exe /Query /TN $LegacyTask /XML 2> $null) -join "`n" } finally { $ErrorActionPreference = $saved }
  if ($LASTEXITCODE -ne 0 -or -not $xml) { return $false }
  $mine = @($Me.User.Value.ToLowerInvariant(), $Me.Name.ToLowerInvariant())
  foreach ($m in [regex]::Matches($xml, '<UserId>([^<]*)</UserId>')) {
    if ($mine -contains $m.Groups[1].Value.Trim().ToLowerInvariant()) { return $true }
  }
  return $false
}
$tasks = @()
if ((Quiet schtasks.exe @("/Query", "/TN", $Task)) -eq 0) { $tasks += $Task }
if (Test-OwnLegacyTask) { $tasks += $LegacyTask }
$hasTask = $tasks.Count -gt 0

# The data folder the installed Gateway task runs with (`--home <folder>` in its definition).
function Get-TaskHome([string] $task) {
  $xml = (Capture schtasks.exe @("/Query", "/TN", $task, "/XML")) -join "`n"
  $am = [regex]::Match($xml, '<Arguments>([^<]*)</Arguments>')
  if (-not $am.Success) { return "" }
  $line = [System.Net.WebUtility]::HtmlDecode($am.Groups[1].Value)
  $h = [regex]::Match($line, '--home\s+(?:"([^"]*)"|(\S+))')
  if (-not $h.Success) { return "" }
  if ($h.Groups[1].Success) { return $h.Groups[1].Value }
  return $h.Groups[2].Value
}

# The Credential Manager items Psyche keeps: generic credentials whose target starts with Psyche/
# (the helper's vault and item entries; apps/win-helper/src/keychain). Only the `target=` part of
# each line is read: the rest is in the display language.
function Get-PsycheCredentials {
  $found = @()
  foreach ($line in (Capture cmdkey.exe @("/list"))) {
    $m = [regex]::Match([string] $line, 'target=(Psyche/\S.*?)\s*$')
    if ($m.Success -and $m.Groups[1].Value -cmatch '^Psyche/' -and $m.Groups[1].Value -notmatch '["\x00-\x1f]') {
      $found += $m.Groups[1].Value
    }
  }
  return @($found | Sort-Object -Unique)
}

# Path safety for -Reset (the same rules as the app's Uninstall sheet). Returns why $p (a full
# path) may not be wiped as the data folder, or an empty string when it may.
$PersonalFolders = @("AppData", "Contacts", "Desktop", "Documents", "Downloads", "Favorites", "Links", "Music", "OneDrive", "Pictures", "Saved Games", "Searches", "Videos", "3D Objects")
function Get-DataFolderProblem([string] $p, [string] $home_) {
  if ($p -notmatch '^([A-Za-z]:\\|\\\\)') { return "it is not an absolute path" }
  if ($p.StartsWith("\\")) { return "it is on a network share" }
  $full = [IO.Path]::GetFullPath($p)
  if ($full.Length -gt 3) { $full = $full.TrimEnd('\') }
  if ($full -match '^[A-Za-z]:\\?$') { return "it is a drive root" }
  if ($full -eq $home_) { return "it is your user folder" }
  if (-not $full.StartsWith($home_ + "\", [StringComparison]::OrdinalIgnoreCase)) { return "it is not inside your user folder" }
  foreach ($d in $PersonalFolders) {
    if ($full -eq (Join-Path $home_ $d)) { return "it is your $d folder" }
  }
  # A link or junction on the way would put the real folder somewhere else.
  for ($cur = $full; $cur.Length -gt $home_.Length; $cur = Split-Path $cur -Parent) {
    $item = Get-Item -LiteralPath $cur -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return "$cur is a link or junction" }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $full "state\psyche.sqlite")) -and -not (Test-Path -LiteralPath (Join-Path $full "config.json"))) {
    return "it has no Psyche marker (state\psyche.sqlite or config.json)"
  }
  return ""
}

# 1b. -Reset: work out exactly what would be deleted, show it, and ask before anything is stopped.
$ResetPaths = @()
$ResetCredentials = @()
$ResetDataDir = ""
$UserProfile = ""
if ($Reset) {
  $UserProfile = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')
  # Which data folder? The one the installed task runs with wins (it is what the Gateway really
  # uses); PSYCHE_HOME from the environment is only a fallback, and a difference is a warning.
  $taskHome = ""
  foreach ($t in $tasks) { if (-not $taskHome) { $taskHome = Get-TaskHome $t } }
  $envHome = if ($env:PSYCHE_HOME) { $env:PSYCHE_HOME } else { "" }
  if ($taskHome) {
    $want = $taskHome
    if ($envHome -and ($envHome.TrimEnd('\', '/') -ne $taskHome.TrimEnd('\', '/'))) {
      Write-Warning "PSYCHE_HOME=$envHome differs from the Gateway task's $taskHome; using the task's"
    }
  } else {
    $want = if ($envHome) { $envHome } else { Join-Path $UserProfile ".psyche" }
  }
  if ($want -notmatch '^([A-Za-z]:\\|\\\\)') { throw "refusing to delete $want as the data folder: not an absolute path" }
  if (Test-Path -LiteralPath $want) {
    $ResetDataDir = [IO.Path]::GetFullPath($want).TrimEnd('\')
    $problem = Get-DataFolderProblem $ResetDataDir $UserProfile
    if ($problem) { throw "refusing to delete $want as the data folder: $problem" }
    if ($Yes -and $ResetDataDir -ne (Join-Path $UserProfile ".psyche")) {
      throw "refusing -Yes: the data folder is $ResetDataDir, not the default $(Join-Path $UserProfile '.psyche'); run -Reset without -Yes and confirm"
    }
  }
  $candidates = @(
    $ResetDataDir,
    (Join-Path $env:APPDATA "Psyche"),
    (Join-Path $env:APPDATA "com.psyche.helper"),
    (Join-Path $env:LOCALAPPDATA "com.psyche.gateway"),
    (Join-Path $env:LOCALAPPDATA "com.psyche.helper"),
    (Join-Path $env:LOCALAPPDATA "Psyche Helper"),
    (Join-Path $InstallRoot "vm-images")
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { $ResetPaths += $c } }
  $ResetCredentials = @(Get-PsycheCredentials)
  Say "-Reset will PERMANENTLY DELETE (not to the Recycle Bin):"
  if ($ResetPaths.Count -eq 0 -and $ResetCredentials.Count -eq 0 -and $tasks.Count -eq 0) { Write-Host "    (nothing: no Psyche data was found)" }
  foreach ($p in $ResetPaths) { Write-Host "    $p" }
  foreach ($t in $tasks) { Write-Host "    Scheduled task $t" }
  foreach ($c in $ResetCredentials) { Write-Host "    Credential Manager item $c" }
  if (-not $DryRun -and -not $Yes) {
    if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
      Write-Error "-Reset needs a terminal to confirm; pass -Yes to skip the question" -ErrorAction Continue
      exit 1
    }
    $answer = Read-Host "Type RESET to delete the above, anything else to cancel"
    if ($answer -cne "RESET") {
      Write-Error "cancelled; nothing was changed" -ErrorAction Continue
      exit 1
    }
  }
} else {
  Say "Keeping your data (pass -Reset to wipe it first)"
}

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
foreach ($t in $tasks) {
  Say "Stopping the Gateway task ($t)"
  Act "schtasks /End /TN $t" { [void] (Quiet schtasks.exe @("/End", "/TN", $t)) }
}
$pidHomes = @($PsycheHome)
if ($ResetDataDir) { $pidHomes += $ResetDataDir }
foreach ($h in ($pidHomes | Sort-Object -Unique)) {
  foreach ($f in @("gateway-service.pid", "gateway.pid")) {
    $pidFile = Join-Path $h "run\$f"
    if (Test-Path $pidFile) {
      $procId = (Get-Content $pidFile -Raw).Trim()
      if ($procId -match '^\d+$' -and (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
        Act "taskkill /PID $procId /T /F" { [void] (Quiet taskkill.exe @("/PID", $procId, "/T", "/F")) }
      }
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

# 3. Reset (only with -Reset): everything the app, the Gateway and the helper keep for this user, so
#    the new build runs first-run onboarding on a clean slate. The list was built before the stop;
#    each entry is checked again now, a failure does not stop the others, and the failures are
#    reported at the end.
$Failed = @()
if ($Reset) {
  Say "Resetting app data and caches"
  foreach ($p in $ResetPaths) {
    if (-not (Test-Path -LiteralPath $p)) { continue }
    if ($p -eq $ResetDataDir) {
      $problem = Get-DataFolderProblem $p $UserProfile
      if ($problem) { $Failed += "$p ($problem)"; continue }
    }
    Write-Host "    removing $p"
    if ($DryRun) { Write-Host "    (dry run) remove $p"; continue }
    try { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop } catch { $Failed += "$p ($($_.Exception.Message))" }
  }
  foreach ($t in $tasks) {
    Write-Host "    removing the scheduled task $t"
    if ($DryRun) { Write-Host "    (dry run) schtasks /Delete /TN $t /F"; continue }
    if ((Quiet schtasks.exe @("/Delete", "/TN", $t, "/F")) -ne 0) { $Failed += "Scheduled task $t" }
  }
  foreach ($c in $ResetCredentials) {
    Write-Host "    removing Credential Manager item $c"
    if ($DryRun) { Write-Host "    (dry run) cmdkey /delete:$c"; continue }
    if ((Quiet cmdkey.exe @("/delete:$c")) -ne 0) { $Failed += "Credential Manager item $c" }
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

if ($Failed.Count -gt 0) {
  [Console]::Error.WriteLine("The install finished, but these could not be removed:")
  foreach ($f in $Failed) { [Console]::Error.WriteLine("    $f") }
  exit 1
}
