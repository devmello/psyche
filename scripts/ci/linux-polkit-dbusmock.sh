#!/usr/bin/env bash
# Runs Psyche's password-presence client against python-dbusmock's logind and a polkitd stand-in
# on a private system bus (tests/linux/polkit_dbusmock_test.py). Exits non-zero on any failure.
# Needs: python3-dbusmock, dbus-daemon, pnpm (with the workspace installed).
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 -c "import dbusmock" 2>/dev/null || {
  echo "python3-dbusmock is not installed (apt-get install python3-dbusmock)" >&2
  exit 2
}
exec python3 tests/linux/polkit_dbusmock_test.py "$@"
