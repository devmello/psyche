#!/bin/sh
# Builds Psyche-<version>-<arch>.dmg from a packaged Psyche.app (feature A6: "Signed DMG installs
# on macOS 15+"). Owner: S22. Runs on macOS only (hdiutil, codesign, notarytool, stapler).
#
#   pnpm --filter @psyche/desktop run package --arch=arm64
#   deploy/macos/make-dmg.sh apps/desktop/out/Psyche-darwin-arm64/Psyche.app 1.0.0 arm64 dist
#
# With a Developer ID: the app is signed and notarized by electron-forge package when
# PSYCHE_SIGN_IDENTITY (and the notarization variables) are set (apps/desktop/docs/signing.md),
# and the same variables sign, notarize and staple the DMG here. Without one, the staged copy of the
# app is signed ad-hoc (`codesign --force --deep --sign -`, no hardened runtime, so the bundled
# psyched's native addons still load) and Gatekeeper asks the owner to open it once from
# System Settings › Privacy & Security. Variables:
#   PSYCHE_SIGN_IDENTITY   "Developer ID Application: Name (TEAMID)"
#   APPLE_API_KEY (path to the .p8), APPLE_API_KEY_ID, APPLE_API_ISSUER     (preferred), or
#   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
# Never commit real values; CI passes them from repository secrets.
set -eu

app="${1:?usage: make-dmg.sh <Psyche.app> <version> <arm64|x64> <out-dir>}"
version="${2:?version}"
arch="${3:?arch}"
out="${4:?out-dir}"

here="$(cd "$(dirname "$0")" && pwd)"
entitlements="${PSYCHE_ENTITLEMENTS:-$here/../../apps/desktop/entitlements.plist}"
background="${PSYCHE_DMG_BACKGROUND:-$here/dmg-background.png}"

case "$arch" in arm64|x64) ;; *) echo "arch must be arm64 or x64" >&2; exit 2 ;; esac
case "$version" in *[!0-9A-Za-z.-]*|"") echo "bad version: $version" >&2; exit 2 ;; esac
[ -d "$app" ] || { echo "no app bundle at $app" >&2; exit 2; }
command -v hdiutil >/dev/null || { echo "make-dmg.sh needs macOS (hdiutil)" >&2; exit 2; }

mkdir -p "$out"
dmg="$out/Psyche-$version-$arch.dmg"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT INT TERM

# Drag-to-install layout: the app and a link to /Applications.
ditto "$app" "$stage/Psyche.app"
ln -s /Applications "$stage/Applications"

# No Developer ID: the package step signs ad-hoc, inside out (the helper keeps its own
# entitlements). An app that arrives unsigned or broken is signed ad-hoc here instead, so the
# bundle is consistently signed (macOS refuses unsigned arm64 code) and psyched's Node runtime and
# addons load (no hardened runtime, so no library validation).
if [ -z "${PSYCHE_SIGN_IDENTITY:-}" ]; then
  if ! codesign --verify --deep --strict "$stage/Psyche.app" 2>/dev/null; then
    echo "note: $app is not validly signed; signing the DMG copy ad-hoc (--deep)" >&2
    codesign --force --deep --sign - --entitlements "$entitlements" "$stage/Psyche.app"
    codesign --verify --deep --strict "$stage/Psyche.app"
  fi
  echo "note: ad-hoc signed (no PSYCHE_SIGN_IDENTITY); open it once from System Settings › Privacy & Security" >&2
fi

volname="Psyche $version"
rm -f "$dmg"
laid_out=0
if [ -f "$background" ] && command -v osascript >/dev/null; then
  # A read-write image, laid out by Finder, then compressed. Finder scripting needs a GUI session;
  # where it is unavailable (some CI hosts) the plain image below is used instead.
  mkdir -p "$stage/.background"
  cp "$background" "$stage/.background/background.png"
  rw="$(mktemp -d)/rw.dmg"
  hdiutil create -volname "$volname" -srcfolder "$stage" -fs APFS -format UDRW -ov "$rw" >/dev/null
  mnt="$(hdiutil attach -readwrite -noverify -noautoopen "$rw" | awk -F'\t' '/\/Volumes\//{print $NF; exit}')"
  if [ -n "$mnt" ] && osascript <<APPLESCRIPT >/dev/null 2>&1
tell application "Finder"
  tell disk "$volname"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 120, 860, 520}
    set opts to the icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to 112
    set background picture of opts to file ".background:background.png"
    set position of item "Psyche.app" of container window to {180, 190}
    set position of item "Applications" of container window to {480, 190}
    close
  end tell
end tell
APPLESCRIPT
  then
    laid_out=1
  else
    echo "warning: Finder layout unavailable; the DMG has no background" >&2
  fi
  [ -n "$mnt" ] && hdiutil detach "$mnt" -quiet || true
  if [ "$laid_out" = 1 ]; then
    hdiutil convert "$rw" -format ULFO -o "$dmg" >/dev/null
  fi
  rm -rf "$(dirname "$rw")"
fi
if [ "$laid_out" != 1 ]; then
  rm -rf "$stage/.background"
  hdiutil create -volname "$volname" -srcfolder "$stage" -fs APFS -format ULFO -ov "$dmg" >/dev/null
fi

if [ -n "${PSYCHE_SIGN_IDENTITY:-}" ]; then
  codesign --force --timestamp --sign "$PSYCHE_SIGN_IDENTITY" "$dmg"
  codesign --verify --strict --verbose=2 "$dmg"
  if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
    xcrun notarytool submit "$dmg" --wait \
      --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"
  elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
    xcrun notarytool submit "$dmg" --wait \
      --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID"
  else
    echo "warning: signed but not notarized (no notarization credentials); Gatekeeper will warn" >&2
  fi
  if [ -n "${APPLE_API_KEY:-}${APPLE_ID:-}" ]; then
    xcrun stapler staple "$dmg"
    spctl --assess --type open --context context:primary-signature --verbose "$dmg"
  fi
fi

# The checksum next to the image (the release also lists it in SHA256SUMS).
(cd "$out" && shasum -a 256 "$(basename "$dmg")" > "$(basename "$dmg").sha256")
echo "$dmg"
