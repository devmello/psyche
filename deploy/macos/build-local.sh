#!/bin/bash
# Build a complete, installable Psyche DMG from this checkout on a Mac:
# psyched (Node runtime + workspace) → PsycheHelper.app → Psyche.app (electron-forge) → DMG in dist/.
#
#   sh deploy/macos/build-local.sh [--arch arm64|x64] [--no-dmg]
#   pnpm app:build            # then: pnpm app:install   (or pnpm app:ship for both)
#
# Signing: PSYCHE_SIGN_IDENTITY when set (the SHA-1 of the self-signed "Psyche Release" certificate, or a
# Developer ID name; PSYCHE_SIGN_KEYCHAIN names the keychain file that holds it, PSYCHE_SIGN_TIMESTAMP=1
# adds Apple's timestamp to a self-signed signature). Otherwise the first identity found in the keychain
# search list: the "Psyche Release" certificate whose SHA-1 is pinned in
# deploy/macos/designated-requirements.txt (deploy/macos/make-signing-cert.sh), "Developer ID Application", then
# "Apple Development", so TCC grants survive rebuilds on this Mac; ad-hoc when there is none (every
# rebuild is then a new app to macOS; install-local.sh says what to reset). Notarization runs only for
# a Developer ID with APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER set; otherwise it is skipped
# and the build log says so.
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
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
  shift
done
case "$ARCH" in arm64|x64) ;; *) echo "--arch must be arm64 or x64" >&2; exit 64 ;; esac
[ "$(uname -s)" = Darwin ] || { echo "build-local.sh runs on macOS" >&2; exit 2; }

if [ -z "${PSYCHE_SIGN_IDENTITY:-}" ]; then
  # Psyche's own certificate is self-signed, so it is never "valid" (trusted) to find-identity: list
  # without -v. It is chosen by the SHA-1 pinned in deploy/macos/designated-requirements.txt, never
  # by name (another certificate can be called "Psyche Release"). While the file still has its
  # placeholder (no certificate made yet), fall back to the first identity named "Psyche Release".
  pinned="$(sed -n 's/^desktop[[:space:]].*certificate leaf = H"\([0-9a-fA-F]\{40\}\)".*/\1/p' deploy/macos/designated-requirements.txt | head -n1)"
  listing="$(security find-identity -p codesigning ${PSYCHE_SIGN_KEYCHAIN:+"$PSYCHE_SIGN_KEYCHAIN"} 2>/dev/null || true)"
  id=""
  if [ -n "$pinned" ]; then
    id="$(printf '%s\n' "$listing" | awk -v h="$(printf '%s' "$pinned" | tr a-f A-F)" 'toupper($2) == h {print $2; exit}')"
  else
    id="$(printf '%s\n' "$listing" | awk '/"Psyche Release"/{print $2; exit}')"
  fi
  [ -n "$id" ] || id="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Developer ID Application/{print $2; exit}')"
  [ -n "$id" ] || id="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Apple Development/{print $2; exit}')"
  if [ -n "$id" ]; then export PSYCHE_SIGN_IDENTITY="$id"; echo "==> signing as $id"; else echo "==> no signing identity; ad-hoc"; fi
fi
case "${PSYCHE_SIGN_IDENTITY:-}" in
  ""|-) ;;
  "Developer ID Application:"*)
    if [ -z "${APPLE_API_KEY:-}" ] && [ -z "${APPLE_ID:-}" ]; then echo "==> notarization skipped: no Apple API key or Apple ID credentials set"; fi ;;
  *) echo "==> notarization skipped: self-signed or non-Developer-ID identity (users approve it once under Privacy & Security, Open Anyway)" ;;
esac
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
