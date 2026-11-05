#!/bin/sh
# Builds rootfs.vhdx, sessiondata.vhdx and the initrd inside Docker (no loop mounts, no root):
#   1. bundle apps/node (esbuild, Node >= 24 and the workspace's node_modules needed on the host)
#   2. build the sandbox image's "base" target from deploy/sandbox-image
#   3. Dockerfile.rootfs: + socat, busybox, the Psyche init, the node bundle -> ext4 -> VHDX (+ .zst)
#   4. Dockerfile.rootfs: initrd
# Output in out/ (or $OUT): rootfs.vhdx rootfs.vhdx.zst sessiondata.vhdx initrd packages.tsv
# and out/work/psyche-node.mjs. IMAGE_VERSION (default: guest-image.json "version") is stamped in
# /usr/lib/psyche/image-version.
set -eu
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
OUT="${OUT:-out}"
VERSION="${IMAGE_VERSION:-$(node -e 'console.log(require("./guest-image.json").version)')}"
mkdir -p "$OUT/work" "$OUT/rootfs"

node bundle-node.mjs "$OUT/work/psyche-node.mjs"

# The sandbox image's shell scripts must have LF endings; a Windows checkout with
# core.autocrlf=true can leave CRLF in the working tree, so build from a normalized copy.
SANDBOX_CTX="$OUT/work/sandbox-ctx"
rm -rf "$SANDBOX_CTX"
mkdir -p "$SANDBOX_CTX"
cp "$ROOT/deploy/sandbox-image/Dockerfile" "$ROOT/deploy/sandbox-image/harden.sh" "$ROOT/deploy/sandbox-image/versions.json" "$SANDBOX_CTX/"
sed -i 's/\r$//' "$SANDBOX_CTX/Dockerfile" "$SANDBOX_CTX/harden.sh"
docker build -f "$SANDBOX_CTX/Dockerfile" --target base -t psyche-sandbox-base:guest-build "$SANDBOX_CTX"

docker build -f Dockerfile.rootfs --target export \
  --build-context "nodebundle=$OUT/work" \
  --build-arg SANDBOX_IMAGE=psyche-sandbox-base:guest-build \
  --build-arg "IMAGE_VERSION=$VERSION" \
  --output "type=local,dest=$OUT/rootfs" .
docker build -f Dockerfile.rootfs --target export-initrd \
  --build-context "nodebundle=$OUT/work" \
  --output "type=local,dest=$OUT/initrd-out" .

cp "$OUT/rootfs/rootfs.vhdx" "$OUT/rootfs/rootfs.vhdx.zst" "$OUT/rootfs/sessiondata.vhdx" "$OUT/rootfs/packages.tsv" "$OUT/"
cp "$OUT/initrd-out/initrd" "$OUT/initrd"
ls -l "$OUT/rootfs.vhdx" "$OUT/rootfs.vhdx.zst" "$OUT/sessiondata.vhdx" "$OUT/initrd"
