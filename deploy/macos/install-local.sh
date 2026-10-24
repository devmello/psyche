#!/bin/bash
# Install a locally built Psyche into /Applications without the drag-and-drop dance.
#
#   sh deploy/macos/install-local.sh                 # newest dist/Psyche-*.dmg, else the packaged .app
#   sh deploy/macos/install-local.sh dist/Psyche-0.3.0-alpha.0-arm64.dmg
#   sh deploy/macos/install-local.sh apps/desktop/out/Psyche-darwin-arm64/Psyche.app
#   pnpm app:install [source] [--no-launch] [--dry-run]
#
# What it does: quits a running Psyche, boots the Gateway LaunchAgent out so nothing runs from the
# old bundle, swaps the app atomically (copy next to it, then rename), verifies the signature, and
# launches the new app, which bootstraps the LaunchAgent again. App data (~/.psyche) is untouched.
# A build signed with the same identity keeps its TCC grants; when the signing identity changes
# (ad-hoc → certificate, or another certificate), it says which `tccutil reset` to run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${PSYCHE_INSTALL_DIR:-/Applications}/Psyche.app"
LABEL="com.psyche.gateway"
LAUNCH=1
DRY=0
SRC=""
for arg in "$@"; do
  case "$arg" in
    --no-launch) LAUNCH=0 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 64 ;;
    *) SRC="$arg" ;;
  esac
done

say() { printf '==> %s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then printf '    (dry run) %s\n' "$*"; else "$@"; fi; }

# 1. Find the source: an explicit path, the newest DMG in dist/, or the packaged app.
if [ -z "$SRC" ]; then
  SRC="$(ls -t "$ROOT"/dist/Psyche-*.dmg 2>/dev/null | head -1 || true)"
  [ -n "$SRC" ] || SRC="$ROOT/apps/desktop/out/Psyche-darwin-arm64/Psyche.app"
fi
[ -e "$SRC" ] || { echo "nothing to install: $SRC does not exist (run pnpm app:build first)" >&2; exit 1; }

MOUNT=""
cleanup() { [ -n "$MOUNT" ] && hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

case "$SRC" in
  *.dmg)
    MOUNT="$(mktemp -d /tmp/psyche-dmg.XXXXXX)"
    say "Mounting $(basename "$SRC")"
    hdiutil attach -nobrowse -readonly -quiet -mountpoint "$MOUNT" "$SRC"
    APP="$MOUNT/Psyche.app" ;;
  *.app) APP="${SRC%/}" ;;
  *) echo "source must be a .dmg or a .app: $SRC" >&2; exit 64 ;;
esac
[ -d "$APP/Contents" ] || { echo "no Psyche.app inside $SRC" >&2; exit 1; }

plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null || echo "?"; }
NEW_VERSION="$(plist "$APP" CFBundleShortVersionString)"
NEW_REQ="$(codesign -d -r - "$APP" 2>/dev/null | sed -n 's/^designated => //p')"
OLD_REQ=""
if [ -d "$DEST" ]; then
  OLD_REQ="$(codesign -d -r - "$DEST" 2>/dev/null | sed -n 's/^designated => //p')"
  say "Replacing Psyche $(plist "$DEST" CFBundleShortVersionString) with $NEW_VERSION"
else
  say "Installing Psyche $NEW_VERSION"
fi
codesign --verify --deep --strict "$APP" 2>/dev/null || { echo "the new app's signature does not verify; not installing" >&2; exit 1; }

# 2. Stop what runs from the old bundle: the app, then the Gateway LaunchAgent (a plain Quit keeps
#    it loaded; "Quit entirely" removes it). The new app bootstraps the agent again on launch.
if pgrep -xq Psyche; then
  say "Quitting Psyche"
  run osascript -e 'tell application "Psyche" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do pgrep -xq Psyche || break; sleep 0.5; done
  if pgrep -xq Psyche && [ "$DRY" = 0 ]; then say "Psyche did not quit; stopping it"; pkill -x Psyche || true; sleep 1; fi
fi
UID_="$(id -u)"
if launchctl print "gui/$UID_/$LABEL" >/dev/null 2>&1; then
  say "Stopping the Gateway LaunchAgent ($LABEL)"
  run launchctl bootout "gui/$UID_/$LABEL" || true
  for _ in $(seq 1 20); do launchctl print "gui/$UID_/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
fi
if pgrep -f "$DEST/Contents/Resources/PsycheHelper.app" >/dev/null 2>&1; then
  say "Stopping the helper"
  run pkill -f "$DEST/Contents/Resources/PsycheHelper.app" || true
fi

# 3. Swap the bundle: copy beside the old one, then rename, so a failed copy leaves the old app.
STAGE="${DEST%.app}.new.app"
say "Copying to $DEST"
run rm -rf "$STAGE"
run ditto "$APP" "$STAGE"
run xattr -dr com.apple.quarantine "$STAGE" 2>/dev/null || true
run rm -rf "$DEST"
run mv "$STAGE" "$DEST"
if [ "$DRY" = 0 ]; then
  codesign --verify --deep --strict "$DEST"
  say "Installed Psyche $(plist "$DEST" CFBundleShortVersionString) ($(codesign -dv "$DEST" 2>&1 | sed -n 's/^Signature=//p;s/^Authority=\(Apple Development.*\|Developer ID.*\)/\1/p' | head -1))"
fi

# 4. Permissions carry over only while the designated requirement is unchanged.
if [ -n "$OLD_REQ" ] && [ "$OLD_REQ" != "$NEW_REQ" ]; then
  cat <<EOF
    The code signature changed, so macOS ties the old permission grants to the old app.
    Clear them once, then grant again when asked:
      tccutil reset All com.psyche.helper && tccutil reset All com.psyche.desktop
EOF
fi

# 5. Launch; the app loads the LaunchAgent again and shows the splash while the Gateway starts.
if [ "$LAUNCH" = 1 ]; then
  say "Launching"
  run open -a "$DEST"
fi
