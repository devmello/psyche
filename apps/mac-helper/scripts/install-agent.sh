#!/bin/sh
# Installs the LaunchAgent that keeps Psyche Helper running (server-node mode).
# Usage: apps/mac-helper/scripts/install-agent.sh [--uninstall]
#   PSYCHE_HELPER_APP  bundle path (default ~/Applications/Psyche Helper.app)
#   PSYCHE_HOME        Psyche home (default ~/.psyche)
set -eu
HERE="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=com.psyche.helper
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi
APP="${PSYCHE_HELPER_APP:-$HOME/Applications/Psyche Helper.app}"
[ -x "$APP/Contents/MacOS/psyche-helper" ] || { echo "no helper at $APP (run scripts/build-app.sh --install)" >&2; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|@APP@|$APP|g" -e "s|@PSYCHE_HOME@|${PSYCHE_HOME:-$HOME/.psyche}|g" "$HERE/Support/$LABEL.plist" > "$PLIST"
chmod 0644 "$PLIST"
# launchd refuses quarantined plists on macOS 27 (security §12).
xattr -d com.apple.quarantine "$PLIST" 2>/dev/null || true
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "loaded $LABEL from $PLIST"
