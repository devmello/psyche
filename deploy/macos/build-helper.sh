#!/bin/sh
# Builds apps/mac-helper/dist/PsycheHelper.app, the Mac helper that ships inside Psyche.app at
# Contents/Resources/PsycheHelper.app (layout and launch contract: docs/status/s14.md "Packaging").
# Owner: S14. macOS only. Run it before `electron-forge package`, with the same signing variables.
#
#   deploy/macos/build-helper.sh [--arch arm64|x64] [--out <dir>]
#
#   PSYCHE_SIGN_IDENTITY   "Developer ID Application: Name (TEAMID)": hardened runtime + secure
#                          timestamp, which notarization of the outer app needs. Unset: ad-hoc.
#   PSYCHE_HELPER_PROFILE  optional provisioning profile (data-protection keychain, time-sensitive
#                          notifications); see apps/mac-helper/scripts/build-app.sh
#   PSYCHE_VERSION         release version (default: apps/desktop/package.json "version")
#
# Ad-hoc limits: the bundle id and the code identifier are always com.psyche.helper, but an ad-hoc
# designated requirement is the cdhash. TCC therefore treats every ad-hoc build as a new app: grants
# made to the previous build stay listed in System Settings and no longer apply. After installing a
# new ad-hoc build, run `tccutil reset All com.psyche.helper` and grant again. Developer ID builds
# keep their grants across upgrades (requirement = identifier + team).
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ARCH=""
OUT="$ROOT/apps/mac-helper/dist"
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="${2:?--arch needs arm64 or x64}"; shift 2 ;;
    --out) OUT="${2:?--out needs a directory}"; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done
command -v codesign >/dev/null || { echo "build-helper.sh needs macOS (codesign)" >&2; exit 2; }

case "$ARCH" in
  "") ;;
  arm64) export PSYCHE_HELPER_ARCH=arm64 ;;
  x64|x86_64) export PSYCHE_HELPER_ARCH=x86_64 ;;
  *) echo "--arch must be arm64 or x64" >&2; exit 64 ;;
esac

VERSION="${PSYCHE_VERSION:-$(node -p 'require(process.argv[1]).version' "$ROOT/apps/desktop/package.json" 2>/dev/null || echo 0.0.0)}"
case "$VERSION" in *[!0-9A-Za-z.+-]*|"") echo "bad version: $VERSION" >&2; exit 2 ;; esac
# CFBundleVersion: up to three integers, increasing release over release ("1.4.0-beta.2" → "1.4.0").
BUILD="$(printf '%s' "$VERSION" | sed -E 's/^([0-9]+(\.[0-9]+){0,2}).*/\1/')"
case "$BUILD" in ""|*[!0-9.]*) echo "version must start with a number: $VERSION" >&2; exit 2 ;; esac

# Ad-hoc unless an identity is given: a packaging build never picks up a random local
# "Apple Development" certificate (build-app.sh does that for development installs).
export PSYCHE_SIGN_IDENTITY="${PSYCHE_SIGN_IDENTITY:--}"
export PSYCHE_HELPER_VERSION="$VERSION"
export PSYCHE_HELPER_BUILD="$BUILD"
export PSYCHE_HELPER_OUT="$OUT/PsycheHelper.app"
mkdir -p "$OUT"
"$ROOT/apps/mac-helper/scripts/build-app.sh"

APP="$PSYCHE_HELPER_OUT"
plutil -lint "$APP/Contents/Info.plist" >/dev/null
for key in CFBundleIdentifier LSUIElement NSAppleEventsUsageDescription NSMicrophoneUsageDescription \
  NSSpeechRecognitionUsageDescription NSContactsUsageDescription NSCalendarsFullAccessUsageDescription \
  NSRemindersFullAccessUsageDescription NSScreenCaptureUsageDescription; do
  /usr/libexec/PlistBuddy -c "Print :$key" "$APP/Contents/Info.plist" >/dev/null \
    || { echo "Info.plist is missing $key" >&2; exit 1; }
done
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")" = com.psyche.helper ] \
  || { echo "bundle id must be com.psyche.helper" >&2; exit 1; }
codesign -d --entitlements - --xml "$APP" 2>/dev/null | grep -q com.apple.security.automation.apple-events \
  || { echo "the signature lost the helper entitlements" >&2; exit 1; }
if [ "$PSYCHE_SIGN_IDENTITY" = "-" ]; then
  echo "note: ad-hoc signature; TCC grants do not survive an upgrade (see the header of this script)" >&2
fi
echo "$APP"
