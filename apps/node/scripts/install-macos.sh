#!/bin/sh
# Installs psyche-node as a LaunchAgent (macOS guest VM or a remote Mac).
# Usage: apps/node/scripts/install-macos.sh [--uninstall] [-- psyche-node flags...]
#   PSYCHE_NODE_HOME   node state (default ~/.psyche/node): identity.json, node.json, run/
#   PSYCHE_REPO        checkout with node_modules installed (default: this script's repo)
#   PSYCHE_NODE_ARGS   extra flags, e.g. "--gateway ws://127.0.0.1:7979/ws" or "--vsock 2:7980"
# With Psyche Helper installed, point it at the node's socket so computer use is proxied:
#   PSYCHE_HOME="$PSYCHE_NODE_HOME" apps/mac-helper/scripts/install-agent.sh
set -eu
REPO="${PSYCHE_REPO:-$(cd "$(dirname "$0")/../../.." && pwd)}"
LABEL=com.psyche.node
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
NODE_HOME="${PSYCHE_NODE_HOME:-$HOME/.psyche/node}"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$PLIST"
  echo "removed $LABEL (state kept in $NODE_HOME)"
  exit 0
fi
NODE_BIN="$(command -v node || true)"
TSX="$REPO/node_modules/.bin/tsx"
[ -n "$NODE_BIN" ] || { echo "node (>= 24) not found on PATH" >&2; exit 1; }
[ -x "$TSX" ] || { echo "no tsx at $TSX (run pnpm install in $REPO)" >&2; exit 1; }
mkdir -p "$NODE_HOME" "$HOME/Library/LaunchAgents" "$NODE_HOME/logs"
chmod 0700 "$NODE_HOME"
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
ARGS=""
for a in ${PSYCHE_NODE_ARGS:-}; do ARGS="$ARGS    <string>$(xml "$a")</string>
"; done
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE_BIN")</string>
    <string>$(xml "$TSX")</string>
    <string>$(xml "$REPO/apps/node/src/main.ts")</string>
    <string>run</string>
$ARGS  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PSYCHE_NODE_HOME</key>
    <string>$(xml "$NODE_HOME")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <!-- A revoked device exits 78; slow restarts keep that from spinning. -->
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardErrorPath</key>
  <string>$(xml "$NODE_HOME/logs/psyche-node.log")</string>
</dict>
</plist>
PLIST
chmod 0644 "$PLIST"
xattr -d com.apple.quarantine "$PLIST" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "loaded $LABEL; pairing code (if pending) appears in $NODE_HOME/logs/psyche-node.log"
