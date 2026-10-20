#!/bin/sh
# Guest-side bootstrap the VM manager (S14, feature L3) runs inside a fresh macOS guest, from the
# installer share (VirtioFS) over SSH or vsock. Idempotent.
#
# Usage: guest-bootstrap.sh --repo DIR [--vsock CID:PORT] [--helper-app PATH]
#   --repo        Psyche checkout or unpacked release on the share, with node_modules
#   --vsock       host Gateway endpoint for this node (default 2:7980; host CID is 2)
#   --helper-app  Psyche Helper.app to install for computer use (optional)
#   PSYCHE_NODE_VSOCK_BRIDGE  vsock bridge argv (JSON) for macOS guests, which ship no vsock CLI
#
# Result: psyche-node runs as a LaunchAgent, prefers vsock, and prints its pairing code to
# ~/.psyche/node/logs/psyche-node.log; the helper (if given) proxies through the node's socket.
set -eu
REPO="" VSOCK="2:7980" HELPER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --vsock) VSOCK="$2"; shift 2 ;;
    --helper-app) HELPER="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 64 ;;
  esac
done
[ -n "$REPO" ] || { echo "--repo is required" >&2; exit 64; }
NODE_HOME="${PSYCHE_NODE_HOME:-$HOME/.psyche/node}"
mkdir -p "$NODE_HOME"
chmod 0700 "$NODE_HOME"
if [ -n "${PSYCHE_NODE_VSOCK_BRIDGE:-}" ] && [ ! -f "$NODE_HOME/node.json" ]; then
  # Persist the bridge so launchd restarts keep it; no fs roots or host exec by default.
  printf '{\n  "gateway": { "vsock": { "cid": %s, "port": %s, "bridge": %s } }\n}\n' \
    "${VSOCK%%:*}" "${VSOCK##*:}" "$PSYCHE_NODE_VSOCK_BRIDGE" > "$NODE_HOME/node.json"
  chmod 0600 "$NODE_HOME/node.json"
fi
PSYCHE_REPO="$REPO" PSYCHE_NODE_HOME="$NODE_HOME" PSYCHE_NODE_ARGS="--vsock $VSOCK" \
  "$REPO/apps/node/scripts/install-macos.sh"
if [ -n "$HELPER" ]; then
  PSYCHE_HELPER_APP="$HELPER" PSYCHE_HOME="$NODE_HOME" "$REPO/apps/mac-helper/scripts/install-agent.sh"
fi
echo "guest bootstrap done; approve the node on the host: psyched devices approve <code>"
