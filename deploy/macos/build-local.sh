#!/bin/bash
# Build a complete, installable Psyche DMG from this checkout on a Mac:
# psyched (Node runtime + workspace) → PsycheHelper.app → Psyche.app (electron-forge) → DMG in dist/.
#
#   sh deploy/macos/build-local.sh [--arch arm64|x64] [--no-dmg]
#   pnpm app:build            # then: pnpm app:install   (or pnpm app:ship for both)
#
# Signing: PSYCHE_SIGN_IDENTITY when set; otherwise the first "Developer ID Application" or
# "Apple Development" identity in the keychain, so TCC grants survive rebuilds on this Mac; ad-hoc
# when there is none (every rebuild is then a new app to macOS; install-local.sh says what to reset).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
ARCH="arm64"
DMG=1
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="$2"; shift ;;
    --arch=*) ARCH="${1#--arch=}" ;;
    --no-dmg) DMG=0 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
  shift
done
case "$ARCH" in arm64|x64) ;; *) echo "--arch must be arm64 or x64" >&2; exit 64 ;; esac
[ "$(uname -s)" = Darwin ] || { echo "build-local.sh runs on macOS" >&2; exit 2; }

if [ -z "${PSYCHE_SIGN_IDENTITY:-}" ]; then
  id="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Developer ID Application/{print $2; exit}')"
  [ -n "$id" ] || id="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Apple Development/{print $2; exit}')"
  if [ -n "$id" ]; then export PSYCHE_SIGN_IDENTITY="$id"; echo "==> signing as $id"; else echo "==> no signing identity; ad-hoc"; fi
fi
export PSYCHE_DMG_LAYOUT="${PSYCHE_DMG_LAYOUT:-0}"
VERSION="$(node -p "require('./apps/desktop/package.json').version")"
step() { printf '\n==> %s (%s)\n' "$1" "$(date '+%H:%M:%S')"; }

step "psyched bundle"
node deploy/scripts/build-psyched.mjs --arch "$ARCH"
step "Mac helper"
sh deploy/macos/build-helper.sh --arch "$ARCH"
step "Psyche.app"
rm -rf apps/desktop/out
pnpm --filter @psyche/desktop run package --arch="$ARCH"
APP="apps/desktop/out/Psyche-darwin-$ARCH/Psyche.app"
[ -d "$APP" ] || { echo "packaging produced no app at $APP" >&2; exit 1; }
if [ "$DMG" = 1 ]; then
  step "DMG"
  mkdir -p dist
  sh deploy/macos/make-dmg.sh "$APP" "$VERSION" "$ARCH" dist
  printf '\n==> done: dist/Psyche-%s-%s.dmg (install with: pnpm app:install)\n' "$VERSION" "$ARCH"
else
  printf '\n==> done: %s (install with: pnpm app:install %s)\n' "$APP" "$APP"
fi
