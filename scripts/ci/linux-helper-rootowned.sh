#!/usr/bin/env bash
# Installs the built Linux helper as root at its packaged path (/usr/lib/psyche/resources/
# linux-helper/psyche-helper, root:root, 0755), runs the Gateway's real peer check as the ordinary
# user against it, and expects `root_owned`. Then removes the install. This is the one test that
# needs real root-owned files and an unprivileged reader of /proc, so it cannot be a fixture.
#
# Linux only, as a non-root user with passwordless sudo (a GitHub runner, the dev VM). It refuses
# to touch an existing /usr/lib/psyche. Exits non-zero on any failure.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ "$(uname -s)" != "Linux" ]; then
  echo "linux-helper-rootowned: Linux only" >&2
  exit 2
fi
if [ "$(id -u)" = "0" ]; then
  echo "linux-helper-rootowned: run as an ordinary user (the test is about an unprivileged reader)" >&2
  exit 2
fi
sudo -n true || { echo "linux-helper-rootowned: needs passwordless sudo" >&2; exit 2; }
if [ -e /usr/lib/psyche ]; then
  echo "linux-helper-rootowned: /usr/lib/psyche already exists; refusing to touch it" >&2
  exit 2
fi

echo "== cargo build (apps/linux-helper)"
(cd apps/linux-helper && cargo build --locked -p psyche-helper)
BIN="$PWD/apps/linux-helper/target/debug/psyche-helper"
test -x "$BIN"

DIR=/usr/lib/psyche/resources/linux-helper
cleanup() { sudo rm -rf /usr/lib/psyche; }
trap cleanup EXIT

echo "== install as root at the packaged path"
sudo install -d -m 755 -o root -g root /usr/lib/psyche /usr/lib/psyche/resources "$DIR"
sudo install -m 755 -o root -g root "$BIN" "$DIR/psyche-helper"

echo "== peer check as $(id -un) against the root-owned helper"
export LINUX_HELPER_ROOTOWNED=1
(cd apps/gateway && pnpm exec vitest run --maxWorkers=1 test/linux-helper-rootowned.test.ts)
echo "linux-helper-rootowned: ok"
