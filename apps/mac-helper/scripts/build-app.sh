#!/bin/sh
# Builds and signs "Psyche Helper.app" (com.psyche.helper) with the hardened runtime.
#
# Usage: apps/mac-helper/scripts/build-app.sh [--install] [--debug]
#   PSYCHE_SIGN_IDENTITY   codesign identity (default: first "Developer ID Application", else first
#                          "Apple Development"; ad-hoc only as a last resort, which loses TCC grants
#                          on every rebuild)
#   PSYCHE_HELPER_PROFILE  provisioning profile to embed. Needed for the data-protection keychain
#                          (keychain-access-groups) and time-sensitive notifications. Without it the
#                          helper runs, but keychain.* answers unavailable/missing_entitlement and the
#                          device key lives in $PSYCHE_HOME/helper/device.key (0600).
#   PSYCHE_HELPER_OUT      output bundle path (default: apps/mac-helper/.build/Psyche Helper.app)
#   PSYCHE_HELPER_VERSION  CFBundleShortVersionString (default: HelperVersion.current)
#   PSYCHE_HELPER_BUILD    CFBundleVersion (default: the commit count)
#   PSYCHE_HELPER_ARCH     arm64 or x86_64 (default: the host's)
#   --install              copy the bundle to ~/Applications/Psyche Helper.app. TCC grants key on the
#                          signature, bundle id and path: keep using one fixed path.
set -eu
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG=release
INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    --debug) CONFIG=debug ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

ID="${PSYCHE_SIGN_IDENTITY:-}"
if [ -z "$ID" ]; then
  ID="$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/{print $2; exit}')"
fi
if [ -z "$ID" ]; then
  ID="$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development/{print $2; exit}')"
fi
if [ -z "$ID" ]; then
  ID="-"
  echo "warning: no signing identity found; signing ad-hoc. TCC grants will not survive a rebuild." >&2
fi

APP="${PSYCHE_HELPER_OUT:-$HERE/.build/Psyche Helper.app}"
ARCH_ARGS=""
if [ -n "${PSYCHE_HELPER_ARCH:-}" ]; then
  case "$PSYCHE_HELPER_ARCH" in arm64|x86_64) ARCH_ARGS="--arch $PSYCHE_HELPER_ARCH" ;; *) echo "PSYCHE_HELPER_ARCH must be arm64 or x86_64" >&2; exit 64 ;; esac
fi
# shellcheck disable=SC2086
swift build --package-path "$HERE" -c "$CONFIG" $ARCH_ARGS --product psyche-helper
# shellcheck disable=SC2086
BIN="$(swift build --package-path "$HERE" -c "$CONFIG" $ARCH_ARGS --show-bin-path)/psyche-helper"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/psyche-helper"
cp "$HERE/Support/Info.plist" "$APP/Contents/Info.plist"
VERSION="${PSYCHE_HELPER_VERSION:-$(sed -n 's/.*current = "\(.*\)".*/\1/p' "$HERE/Sources/PsycheHelperSystem/HelperVersion.swift")}"
BUILD="${PSYCHE_HELPER_BUILD:-$(git -C "$HERE" rev-list --count HEAD 2>/dev/null || echo 1)}"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$BUILD" "$APP/Contents/Info.plist"

ENT="$(mktemp -t psyche-helper-ent)"
trap 'rm -f "$ENT" "$ENT.profile"' EXIT
cp "$HERE/Support/PsycheHelper.entitlements" "$ENT"
if [ -n "${PSYCHE_HELPER_PROFILE:-}" ]; then
  cp "$PSYCHE_HELPER_PROFILE" "$APP/Contents/embedded.provisionprofile"
  security cms -D -i "$PSYCHE_HELPER_PROFILE" > "$ENT.profile"
  TEAM="$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$ENT.profile")"
  GROUP="$TEAM.com.psyche.helper"
  plutil -insert com\\.apple\\.application-identifier -string "$GROUP" "$ENT"
  plutil -insert com\\.apple\\.developer\\.team-identifier -string "$TEAM" "$ENT"
  plutil -insert keychain-access-groups -json "[\"$GROUP\"]" "$ENT"
  if /usr/libexec/PlistBuddy -c 'Print :Entitlements:com.apple.developer.usernotifications.time-sensitive' "$ENT.profile" >/dev/null 2>&1; then
    plutil -insert com\\.apple\\.developer\\.usernotifications\\.time-sensitive -bool YES "$ENT"
  fi
  plutil -replace PsycheKeychainAccessGroup -string "$GROUP" "$APP/Contents/Info.plist"
fi

TIMESTAMP="--timestamp=none"
case "$ID" in "Developer ID"*) TIMESTAMP="--timestamp" ;; esac
# A fixed identifier keeps the designated requirement stable (identifier + team for a real
# identity; ad-hoc requirements are the cdhash, so TCC still sees each ad-hoc build as new).
codesign --force --options runtime $TIMESTAMP --identifier com.psyche.helper --entitlements "$ENT" --sign "$ID" "$APP"
codesign --verify --strict --verbose=1 "$APP"
codesign -dv "$APP" 2>&1 | grep -E '^(Identifier|TeamIdentifier|Authority=(Developer|Apple Dev))' || true

if [ "$INSTALL" = 1 ]; then
  DEST="$HOME/Applications/Psyche Helper.app"
  mkdir -p "$HOME/Applications"
  rm -rf "$DEST"
  ditto "$APP" "$DEST"
  echo "installed: $DEST"
else
  echo "built: $APP"
fi
