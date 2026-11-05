#!/bin/sh
# Builds the guest kernel (Microsoft WSL2-Linux-Kernel at a pinned commit + config-wsl +
# psyche-kernel.fragment) inside Docker. Output in out/ (or $OUT):
#   vmlinuz  kernel.config  kernel-info.json
# ~10-20 minutes on 12 cores, ~6 GB of disk for Docker's build cache. Docker Desktop, WSL2 with
# Docker, or any Linux with Docker works. Rebuilds are cached unless the Dockerfile, the fragment
# or the pinned commit changes.
#   build-kernel.sh [--tag linux-msft-wsl-X --commit SHA]
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")"
OUT="${OUT:-out}"
ARGS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) ARGS="$ARGS --build-arg WSL_KERNEL_TAG=${2:?}"; shift 2 ;;
    --commit) ARGS="$ARGS --build-arg WSL_KERNEL_COMMIT=${2:?}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done
mkdir -p "$OUT/kernel"
# shellcheck disable=SC2086
docker build -f Dockerfile.kernel --target export --output "type=local,dest=$OUT/kernel" $ARGS .
cp "$OUT/kernel/vmlinuz" "$OUT/kernel/kernel.config" "$OUT/kernel/kernel-info.json" "$OUT/"
ls -l "$OUT/vmlinuz"
