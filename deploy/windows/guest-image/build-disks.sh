#!/bin/sh
# Runs inside the "disks" stage of Dockerfile.rootfs: <rootfs directory> -> ext4 image -> VHDX.
#   build-disks.sh /rootfs /out
# Writes rootfs.vhdx (dynamic), rootfs.vhdx.zst, sessiondata.vhdx (empty template), packages.tsv.
set -eu
SRC="${1:?rootfs directory}"
OUT="${2:?output directory}"
SESSION_GIB="${SESSION_GIB:-8}"
mkdir -p "$OUT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

used="$(du -sb "$SRC" | cut -f1)"
files="$(find "$SRC" -xdev | wc -l)"
# The root is mounted read-only (overlay on tmpfs above it): only a little slack for metadata.
size=$(( (used * 110 / 100 + 64 * 1048576) / 1048576 * 1048576 ))
inodes=$(( files * 13 / 10 + 4096 ))
echo "rootfs: $used bytes in $files files -> ext4 of $((size / 1048576)) MiB, $inodes inodes"

truncate -s "$size" "$WORK/rootfs.ext4"
mke2fs -q -t ext4 -b 4096 -m 0 -N "$inodes" -L psyche-root -O ^has_journal \
  -E root_owner=0:0,lazy_itable_init=0 -d "$SRC" "$WORK/rootfs.ext4"
e2fsck -fn "$WORK/rootfs.ext4"

qemu-img convert -f raw -O vhdx -o subformat=dynamic,block_size=1048576 "$WORK/rootfs.ext4" "$OUT/rootfs.vhdx"
rm -f "$WORK/rootfs.ext4"
# Default window (8 MiB at -19): any zstd streaming decoder reads it without a window-size option.
zstd -q -19 -T0 -f "$OUT/rootfs.vhdx" -o "$OUT/rootfs.vhdx.zst"

# Empty session disk: the guest formats it (label psyche-data) on first boot and grows the
# filesystem when the host enlarges the VHDX.
qemu-img create -q -f vhdx -o subformat=dynamic,block_size=1048576 "$OUT/sessiondata.vhdx" "${SESSION_GIB}G"

cp "$SRC/usr/share/psyche/packages.tsv" "$OUT/packages.tsv"
qemu-img info "$OUT/rootfs.vhdx" | sed -n '1,8p'
ls -l "$OUT"
