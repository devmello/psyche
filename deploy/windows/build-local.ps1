<#
.SYNOPSIS
  Build a complete, installable Psyche for Windows from this checkout:
  psyched (Node runtime + workspace) -> psyche-helper.exe -> Psyche (electron-forge make) -> dist\.

.DESCRIPTION
    powershell -File deploy\windows\build-local.ps1 [-Arch x64] [-SkipHelper] [-Smoke] [-NoInstaller]
    pnpm app:build            # then: pnpm app:install   (or pnpm app:ship for both)

  Output in dist\:
    Psyche-<version>-Setup.exe          the Squirrel.Windows installer (per user, no admin)
    Psyche-<version>-win32-x64.zip      the same app, portable (unzip and run Psyche.exe)
    squirrel-win32-x64\RELEASES, Psyche-<nuget-version>-full.nupkg
                                        the update feed files the signed update manifest names

  Signing (Authenticode) is off unless WINDOWS_CERTIFICATE_FILE + WINDOWS_CERTIFICATE_PASSWORD or the
  AZURE_TRUSTED_SIGNING_* variables are set (apps/desktop/docs/signing.md "Windows"); an unsigned
  build installs and runs, SmartScreen just warns about it.

  -SkipHelper packages without resources\win-helper\psyche-helper.exe (PSYCHE_PACKAGE_ALLOW_PARTIAL=1):
  for a checkout without apps\win-helper, never for a release. -Smoke runs build-psyched's smoke test
  (starts the bundled Gateway). -NoInstaller stops after `electron-forge package`.
#>
[CmdletBinding()]
param(
  [ValidateSet("x64")] [string] $Arch = "x64",
  [switch] $SkipHelper,
  [switch] $Smoke,
  [switch] $NoInstaller
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Root

function Step([string] $what) { Write-Host ""; Write-Host ("==> {0} ({1})" -f $what, (Get-Date -Format "HH:mm:ss")) }
function Need([string] $cmd, [string] $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd is not on PATH: $hint" }
}
# Native commands: stop on a non-zero exit. Their stderr (warnings) is not an error: Windows
# PowerShell 5.1 would make it a terminating one under ErrorActionPreference=Stop.
function Run([string] $cmd, [string[]] $argv) {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $cmd @argv 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $saved }
  if ($LASTEXITCODE -ne 0) { throw "$cmd $($argv -join ' ') failed (exit $LASTEXITCODE)" }
}

if ($env:OS -ne "Windows_NT") { throw "build-local.ps1 runs on Windows" }
Need node "install Node 24 (.nvmrc)"
Need pnpm "corepack enable, or install pnpm (packageManager in package.json)"
$Version = (Get-Content (Join-Path $Root "apps\desktop\package.json") -Raw | ConvertFrom-Json).version

if ($env:WINDOWS_CERTIFICATE_FILE -or $env:AZURE_TRUSTED_SIGNING_ENDPOINT) {
  Write-Host "==> signing with Authenticode ($(if ($env:WINDOWS_CERTIFICATE_FILE) { 'PFX' } else { 'Azure Trusted Signing' }))"
} else {
  Write-Host "==> no Windows signing credentials; the build is unsigned"
}

Step "psyched bundle"
$psychedArgs = @("deploy/scripts/build-psyched.mjs", "--arch", $Arch)
if ($Smoke) { $psychedArgs += "--smoke" }
Run node $psychedArgs

if ($SkipHelper) {
  Step "Windows helper (skipped: -SkipHelper; the package has no psyche-helper.exe)"
  $env:PSYCHE_PACKAGE_ALLOW_PARTIAL = "1"
} else {
  Step "Windows helper"
  $manifest = Join-Path $Root "apps\win-helper\Cargo.toml"
  if (-not (Test-Path $manifest)) {
    throw "apps\win-helper\Cargo.toml is missing: this checkout has no Windows helper crate. Build without it with -SkipHelper (dev only)."
  }
  Need cargo "install Rust (https://rustup.rs) with the MSVC toolchain"
  Run cargo @("build", "--release", "--manifest-path", $manifest)
  $exe = Join-Path $Root "apps\win-helper\target\release\psyche-helper.exe"
  if (-not (Test-Path $exe)) { throw "cargo build produced no $exe" }
  # The sandbox PC's service (installed elevated by "Turn on the sandbox PC"), same workspace.
  $svc = Join-Path $Root "apps\win-helper\target\release\psyche-vm-svc.exe"
  if (-not (Test-Path $svc)) { throw "cargo build produced no $svc" }
}

Step "Psyche (electron-forge $(if ($NoInstaller) { 'package' } else { 'make' }))"
$out = Join-Path $Root "apps\desktop\out"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
$forge = if ($NoInstaller) { "package" } else { "make" }
Run pnpm @("--filter", "@psyche/desktop", "run", $forge, "--arch=$Arch", "--platform=win32")

$app = Join-Path $out "Psyche-win32-$Arch"
if (-not (Test-Path (Join-Path $app "Psyche.exe"))) { throw "packaging produced no app at $app" }
if ($NoInstaller) {
  Write-Host ""
  Write-Host "==> done: $app\Psyche.exe (unpackaged; run pnpm app:build without -NoInstaller for the installer)"
  exit 0
}

Step "dist"
$dist = Join-Path $Root "dist"
$feed = Join-Path $dist "squirrel-win32-$Arch"
New-Item -ItemType Directory -Force $dist | Out-Null
if (Test-Path $feed) { Remove-Item -Recurse -Force $feed }
New-Item -ItemType Directory -Force $feed | Out-Null
$squirrel = Join-Path $out "make\squirrel.windows\$Arch"
$setup = Join-Path $squirrel "Psyche-$Version-Setup.exe"
if (-not (Test-Path $setup)) { throw "no installer at $setup" }
Copy-Item $setup (Join-Path $dist "Psyche-$Version-Setup.exe") -Force
Copy-Item (Join-Path $squirrel "RELEASES") $feed -Force
# This version's packages only: with PSYCHE_SQUIRREL_REMOTE_RELEASES (a delta build) Squirrel also
# leaves the previous release's full nupkg there. NuGet's version drops the dots after the dash
# (electron-winstaller convertVersion: 0.3.0-alpha.0 -> 0.3.0-alpha0).
$parts = $Version.Split('+')[0].Split('-')
$nugetVersion = if ($parts.Count -gt 1) { "$($parts[0])-$((($parts[1..($parts.Count - 1)]) -join '-').Replace('.', ''))" } else { $parts[0] }
Get-ChildItem $squirrel -Filter "Psyche-$nugetVersion-*.nupkg" | ForEach-Object { Copy-Item $_.FullName $feed -Force }
if (-not (Test-Path (Join-Path $feed "Psyche-$nugetVersion-full.nupkg"))) { throw "no Psyche-$nugetVersion-full.nupkg in $squirrel" }
$zip = Get-ChildItem (Join-Path $out "make\zip\win32\$Arch") -Filter "*.zip" | Select-Object -First 1
if ($zip) { Copy-Item $zip.FullName (Join-Path $dist "Psyche-$Version-win32-$Arch.zip") -Force }

$sig = (Get-AuthenticodeSignature (Join-Path $app "Psyche.exe")).Status
$mb = [math]::Round((Get-Item (Join-Path $dist "Psyche-$Version-Setup.exe")).Length / 1MB, 1)
Write-Host ""
Write-Host "==> done: dist\Psyche-$Version-Setup.exe ($mb MB, signature: $sig)"
Write-Host "    dist\Psyche-$Version-win32-$Arch.zip, dist\squirrel-win32-$Arch\ (RELEASES + nupkg)"
Write-Host "    install with: pnpm app:install"
