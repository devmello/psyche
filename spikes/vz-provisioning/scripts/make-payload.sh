#!/bin/sh
# Assembles the directory the guest sees over VirtioFS: node, the agent, the vsock bridge,
# axcheck. Node comes from the host (same arch, one self-contained binary), so the guest
# needs no network for this step.  Usage: make-payload.sh <dir>
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$HOME/.psyche-spike06/payload}
mkdir -p "$out"
cp "$(command -v node)" "$out/node"
cp "$here/guest/agent.js" "$here/.build/guest/vsock-bridge" "$here/.build/guest/axcheck" "$here/scripts/guest-install.sh" "$out/"
# The designated requirement of node, compiled to the binary form TCC stores in access.csreq.
codesign -d -r- "$out/node" 2>/dev/null | sed -n 's/^designated => //p' > "$out/node.req"
csreq -r "$out/node.req" -b "$out/node.csreq"
xxd -p "$out/node.csreq" | tr -d '\n' > "$out/node.csreq.hex"
echo "payload in $out: $(ls "$out" | tr '\n' ' ')"
echo "node DR: $(cat "$out/node.req")"
