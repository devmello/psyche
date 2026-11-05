#!/usr/bin/env bash
# Pairs the real Rust Linux helper (apps/linux-helper) with a real Gateway over node.sock, with
# the real Linux peer check, and runs the "host helper" conformance profile against it. Also
# checks that a helper without the handshake secret, another program claiming linux-helper, and
# a linux-helper on the WebSocket are refused or stored as `remote`.
#
# Linux only. Needs node, pnpm (dependencies installed), a Rust toolchain and `ss` (iproute2).
# Everything lives in temp directories (the test makes its own PSYCHE_HOME and helper state), so
# no systemd and no desktop session are involved. Exits non-zero on any failure.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ "$(uname -s)" != "Linux" ]; then
  echo "linux-helper-conformance: Linux only" >&2
  exit 2
fi
command -v ss >/dev/null || { echo "linux-helper-conformance: ss (iproute2) is required" >&2; exit 2; }

echo "== cargo build (apps/linux-helper)"
(cd apps/linux-helper && cargo build --locked -p psyche-helper)

export PSYCHE_LINUX_HELPER_BIN="$PWD/apps/linux-helper/target/debug/psyche-helper"
test -x "$PSYCHE_LINUX_HELPER_BIN"

echo "== host-helper conformance + pairing against the Gateway"
cd apps/gateway
pnpm exec vitest run --maxWorkers=1 \
  test/linux-helper-pairing.test.ts \
  test/linux-helper-peer-check.test.ts
cd ../../packages/testing
pnpm exec vitest run --maxWorkers=1 test/conformance.test.ts
echo "linux-helper-conformance: ok"
