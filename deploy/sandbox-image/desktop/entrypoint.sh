#!/bin/sh
# Init for the separate-desktop container (desktop target of the Dockerfile). Runs as UID 1000
# under tini, on a read-only root filesystem: everything it writes is under /tmp (tmpfs).
#
# Rules this script keeps, because /workspace persists between tasks and a task may have planted
# files there:
# - PATH is /usr/bin:/bin, and every program is named by its absolute path. Nothing is found by
#   searching a folder the container can write.
# - The pairing token never goes through the environment (it would be in /proc/1/environ and in
#   `podman inspect`). It is read from a file the Gateway mounts, the file is emptied at once, and
#   the token reaches the helper through a named pipe that holds nothing once it has been read.
#
# Order: the helper pairs with the Gateway before any app can run, because apps only start when the
# helper is asked to open one.
#   1. a private session D-Bus, 2. Xvfb on :1, 3. the AT-SPI bus, 4. the helper (foreground).
# If the helper exits, so does the container: nothing keeps running without it.
PATH=/usr/bin:/bin
export PATH
set -eu
umask 077

TOKEN_FILE=/run/psyche/token
SOCKET="${PSYCHE_NODE_SOCKET:-/run/psyche/node.sock}"

if [ ! -S "$SOCKET" ]; then
  echo "desktop-entrypoint: the Gateway socket is not mounted; refusing to start" >&2
  exit 65
fi
# Read the token into a shell variable (not exported: it is not in any environment), then empty
# the file, which is the Gateway's own file and is removed on the host.
token=
IFS= read -r token < "$TOKEN_FILE" || true
: > "$TOKEN_FILE"
if [ -z "$token" ]; then
  echo "desktop-entrypoint: no pairing token; refusing to start" >&2
  exit 64
fi

/usr/bin/mkdir -p "$XDG_RUNTIME_DIR" "$PSYCHE_HOME/run" "$PSYCHE_HELPER_STATE"
/usr/bin/chmod 0700 "$XDG_RUNTIME_DIR" "$PSYCHE_HOME" "$PSYCHE_HOME/run" "$PSYCHE_HELPER_STATE"

# The helper reads its secret from this path. A named pipe: the token passes through once, to the
# first reader, and is not stored anywhere (a later read finds no writer and waits).
/usr/bin/mkfifo -m 0600 "$PSYCHE_HOME/run/handshake.secret"
(printf '%s\n' "$token" > "$PSYCHE_HOME/run/handshake.secret") &
token=

/usr/bin/mkdir -p /tmp/.X11-unix
/usr/bin/chmod 1777 /tmp/.X11-unix 2> /dev/null || true

/usr/bin/dbus-daemon --session --nofork --nopidfile --address="unix:path=$XDG_RUNTIME_DIR/bus" &
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"

# -ac: every process in this container is the same user and the same trust domain; the X socket
# is not reachable from outside it, and there is no TCP listener.
/usr/bin/Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp -ac &

/usr/libexec/at-spi-bus-launcher --launch-immediately &

# Wait (at most 10 s) for the display and the session bus before the helper starts.
i=0
while [ "$i" -lt 100 ]; do
  if [ -S "/tmp/.X11-unix/X${DISPLAY#:}" ] && [ -S "$XDG_RUNTIME_DIR/bus" ]; then break; fi
  i=$((i + 1))
  /usr/bin/sleep 0.1
done
if [ ! -S "/tmp/.X11-unix/X${DISPLAY#:}" ]; then
  echo "desktop-entrypoint: Xvfb did not start" >&2
  exit 70
fi

# Never exits when idle: the Gateway stops the container when the Task ends.
exec /usr/local/bin/psyche-helper --idle-timeout 0
