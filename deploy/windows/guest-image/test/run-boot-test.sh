#!/bin/sh
# Boot-tests out/{vmlinuz,initrd,rootfs.vhdx,sessiondata.vhdx} under QEMU in a throwaway container
# (see qemu-boot-test.py for what it proves). Needs Docker; uses /dev/kvm when the engine has it.
#   test/run-boot-test.sh [outDir]
set -eu
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(cd "${1:-$HERE/../out}" && pwd)"
KVM=""
[ -e /dev/kvm ] && KVM="--device /dev/kvm"
# shellcheck disable=SC2086
docker run --rm $KVM -v "$OUT:/out:ro" -v "$HERE:/test:ro" \
  debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 \
  sh -c 'apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends qemu-system-x86 qemu-utils python3 e2fsprogs >/dev/null && python3 /test/qemu-boot-test.py /out'
