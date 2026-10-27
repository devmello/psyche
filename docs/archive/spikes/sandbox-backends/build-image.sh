#!/usr/bin/env bash
# Build the spike sandbox image once per backend. Usage: ./build-image.sh apple|docker|colima
BACKEND=${1:?usage: build-image.sh apple|docker|colima}
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
cd "$SPIKE_DIR" || exit 1
t0=$(now_ms)
case $BACKEND in
  # `container build` runs BuildKit in its own builder VM (started, and pulled, on first use).
  apple) container build --progress plain -t "$IMAGE" . </dev/null ;;
  *) docker build -t "$IMAGE" . ;;
esac
rc=$?
log "build exit $rc in $(( $(now_ms) - t0 )) ms"
exit $rc
