<#
.SYNOPSIS
  Builds the Psyche Windows guest image (the Linux "sandbox PC" VM): vmlinuz, initrd,
  rootfs.vhdx(.zst), sessiondata.vhdx and manifest.json, in deploy\windows\guest-image\out\.

.DESCRIPTION
  Needs Docker (Docker Desktop or any engine), Node 24 with the workspace installed (pnpm install),
  and a POSIX shell (Git for Windows' bash, or any bash on Linux/macOS). Runs on Windows 11 and on
  Linux CI (pwsh). Nothing is installed on the host and no WSL distro is touched: every step runs
  in throwaway build containers. About 20-40 minutes cold (the kernel dominates); rebuilds reuse
  Docker's cache.

    1. build-kernel.sh   Microsoft WSL2 kernel (pinned commit) + psyche-kernel.fragment -> out\vmlinuz
    2. build-rootfs.sh   apps/node bundle + sandbox image + Psyche init -> ext4 -> out\rootfs.vhdx(.zst),
                         out\sessiondata.vhdx, out\initrd
    3. make-manifest.mjs out\manifest.json + out\SHA256SUMS
    4. test\run-boot-test.sh (with -BootTest) boots the result under QEMU

.PARAMETER Out          Output directory (default: out next to this script).
.PARAMETER SkipKernel   Reuse out\vmlinuz, kernel.config and kernel-info.json from a previous build.
.PARAMETER SkipRootfs   Reuse out\rootfs.vhdx, rootfs.vhdx.zst, sessiondata.vhdx, initrd, packages.tsv.
.PARAMETER BootTest     Run the QEMU boot test after building.
.PARAMETER Version      Image version (default: guest-image.json "version"); stamped in the rootfs.
#>
[CmdletBinding()]
param(
  [string]$Out,
  [switch]$SkipKernel,
  [switch]$SkipRootfs,
  [switch]$BootTest,
  [string]$Version
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$here = $PSScriptRoot
if (-not $Out) { $Out = Join-Path $here 'out' }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path $Out).Path

function Find-Bash {
  if ($IsWindows -or $env:OS -eq 'Windows_NT') {
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    $candidates = @()
    if ($git) { $candidates += (Join-Path (Split-Path (Split-Path $git.Source)) 'bin\bash.exe') }
    $candidates += "$env:ProgramFiles\Git\bin\bash.exe"
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    throw "Git for Windows' bash.exe was not found (install Git for Windows). WSL's bash is not used: Docker must be the host's."
  }
  return (Get-Command bash -ErrorAction Stop).Source
}

foreach ($tool in 'docker', 'node') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is required on PATH" }
}
& docker version --format '{{.Server.Os}}' *> $null
if ($LASTEXITCODE -ne 0) { throw 'The Docker engine is not running (start Docker Desktop).' }
$bash = Find-Bash
$env:OUT = $Out
if ($Version) { $env:IMAGE_VERSION = $Version }
$sw = [Diagnostics.Stopwatch]::StartNew()

function Invoke-Step($name, [scriptblock]$body) {
  Write-Host "==> $name" -ForegroundColor Cyan
  $t = [Diagnostics.Stopwatch]::StartNew()
  & $body
  if ($LASTEXITCODE -ne 0) { throw "$name failed (exit $LASTEXITCODE)" }
  Write-Host ("    done in {0:n0} s" -f $t.Elapsed.TotalSeconds)
}

Push-Location $here
try {
  if (-not $SkipKernel) { Invoke-Step 'kernel' { & $bash ./build-kernel.sh } }
  if (-not $SkipRootfs) { Invoke-Step 'rootfs, initrd, session disk' { & $bash ./build-rootfs.sh } }
  Invoke-Step 'manifest' { & node ./make-manifest.mjs $Out }
  if ($BootTest) { Invoke-Step 'QEMU boot test' { & $bash ./test/run-boot-test.sh $Out } }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host ("Guest image built in {0:n0} s -> {1}" -f $sw.Elapsed.TotalSeconds, $Out) -ForegroundColor Green
$manifest = Get-Content (Join-Path $Out 'manifest.json') -Raw | ConvertFrom-Json
Write-Host "imageVersion $($manifest.imageVersion)"
foreach ($f in 'vmlinuz', 'initrd', 'sessiondata') {
  $e = $manifest.files.$f
  Write-Host ("  {0,-24} {1,12:n0} bytes  {2}" -f $e.name, $e.size, $e.sha256)
}
$r = $manifest.files.rootfs
Write-Host ("  {0,-24} {1,12:n0} bytes  {2}" -f $r.name, $r.size, $r.sha256)
Write-Host ("  {0,-24} {1,12:n0} bytes  {2}" -f $r.compressed.name, $r.compressed.size, $r.compressed.sha256)
