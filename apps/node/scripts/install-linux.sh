#!/bin/sh
# Installs psyche-node as a systemd user service (Linux box or Linux VM guest).
# Usage: apps/node/scripts/install-linux.sh [--uninstall]
#   PSYCHE_NODE_HOME   node state (default ~/.psyche/node)
#   PSYCHE_REPO        checkout with node_modules installed (default: this script's repo)
#   PSYCHE_NODE_ARGS   extra flags, e.g. "--gateway ws://100.64.0.1:7979/ws" or "--vsock 2:7980"
# For a node that should run without a login session: loginctl enable-linger "$USER".
set -eu
REPO="${PSYCHE_REPO:-$(cd "$(dirname "$0")/../../.." && pwd)}"
UNIT=psyche-node.service
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
NODE_HOME="${PSYCHE_NODE_HOME:-$HOME/.psyche/node}"
if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
  rm -f "$UNIT_DIR/$UNIT"
  systemctl --user daemon-reload
  echo "removed $UNIT (state kept in $NODE_HOME)"
  exit 0
fi
NODE_BIN="$(command -v node || true)"
TSX="$REPO/node_modules/.bin/tsx"
[ -n "$NODE_BIN" ] || { echo "node (>= 24) not found on PATH" >&2; exit 1; }
[ -x "$TSX" ] || { echo "no tsx at $TSX (run pnpm install in $REPO)" >&2; exit 1; }
mkdir -p "$NODE_HOME" "$UNIT_DIR"
chmod 0700 "$NODE_HOME"
cat > "$UNIT_DIR/$UNIT" <<UNIT
[Unit]
Description=psyche-node (Psyche node agent)
After=network-online.target

[Service]
Environment=PSYCHE_NODE_HOME=$NODE_HOME
ExecStart=$NODE_BIN $TSX $REPO/apps/node/src/main.ts run ${PSYCHE_NODE_ARGS:-}
Restart=on-failure
RestartSec=5
# 78 (EX_CONFIG): revoked device, key/role mismatch or protocol mismatch; retrying cannot help.
RestartPreventExitStatus=78 64
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now "$UNIT"
echo "started $UNIT; pairing code (if pending): journalctl --user -u $UNIT | grep code"
