#!/bin/sh
# Builds Psyche-<version>-<arch>.dmg from a packaged Psyche.app (feature A6: "Signed DMG installs
# on macOS 15+"). Owner: S22. Runs on macOS only (hdiutil, codesign, notarytool, stapler).
#
#   pnpm --filter @psyche/desktop run package --arch=arm64
#   deploy/macos/make-dmg.sh apps/desktop/out/Psyche-darwin-arm64/Psyche.app 1.0.0 arm64 dist
#
# Unsigned by default. The app itself is signed and notarized by electron-forge package when
# PSYCHE_SIGN_IDENTITY (and the notarization variables) are set (apps/desktop/docs/signing.md).
# The same variables sign, notarize and staple the DMG here:
#   PSYCHE_SIGN_IDENTITY   "Developer ID Application: Name (TEAMID)"
#   APPLE_API_KEY (path to the .p8), APPLE_API_KEY_ID, APPLE_API_ISSUER     (preferred), or
#   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
# Never commit real values; CI passes them from repository secrets.
set -eu

app="${1:?usage: make-dmg.sh <Psyche.app> <version> <arm64|x64> <out-dir>}"
version="${2:?version}"
arch="${3:?arch}"
out="${4:?out-dir}"

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
rm -f "$dmg"
hdiutil create -volname "Psyche $version" -srcfolder "$stage" -fs APFS -format ULFO -ov "$dmg" >/dev/null

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
else
  echo "note: unsigned DMG (set PSYCHE_SIGN_IDENTITY to sign); first open needs right-click > Open" >&2
fi

echo "$dmg"
