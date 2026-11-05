#!/bin/sh
# Init for the separate-desktop container (desktop target of the Dockerfile). Runs as UID 1000
# under tini, on a read-only root filesystem: everything it writes is under /tmp (tmpfs).
#
# Order matters: the helper pairs with the Gateway (its single-use token is in the environment)
# before any app can run, because apps only start when the helper is asked to open one.
#   1. a private session D-Bus, 2. Xvfb on :1, 3. the AT-SPI bus, 4. the helper (foreground).
# If the helper exits, so does the container: nothing keeps running without it.
set -eu
umask 077

token="${PSYCHE_GUEST_TOKEN:-}"
unset PSYCHE_GUEST_TOKEN
if [ -z "$token" ]; then
  echo "desktop-entrypoint: no pairing token; refusing to start" >&2
  exit 64
fi
if [ ! -S "${PSYCHE_NODE_SOCKET:-/run/psyche/node.sock}" ]; then
  echo "desktop-entrypoint: the Gateway socket is not mounted; refusing to start" >&2
  exit 65
fi

mkdir -p "$XDG_RUNTIME_DIR" "$PSYCHE_HOME/run" "$PSYCHE_HELPER_STATE"
chmod 0700 "$XDG_RUNTIME_DIR" "$PSYCHE_HOME" "$PSYCHE_HOME/run" "$PSYCHE_HELPER_STATE"
# The helper reads the token the way it reads the Host's handshake secret.
printf '%s\n' "$token" > "$PSYCHE_HOME/run/handshake.secret"
unset token

mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix 2> /dev/null || true

dbus-daemon --session --nofork --nopidfile --address="unix:path=$XDG_RUNTIME_DIR/bus" &
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"

# -ac: every process in this container is the same user and the same trust domain; the X socket
# is not reachable from outside it, and there is no TCP listener.
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp -ac &

/usr/libexec/at-spi-bus-launcher --launch-immediately &

# Wait (at most 10 s) for the display and the session bus before the helper starts.
i=0
while [ "$i" -lt 100 ]; do
  if [ -S "/tmp/.X11-unix/X${DISPLAY#:}" ] && [ -S "$XDG_RUNTIME_DIR/bus" ]; then break; fi
  i=$((i + 1))
  sleep 0.1
done
if [ ! -S "/tmp/.X11-unix/X${DISPLAY#:}" ]; then
  echo "desktop-entrypoint: Xvfb did not start" >&2
  exit 70
fi

# Never exits when idle: the Gateway stops the container when the Task ends.
exec /usr/local/bin/psyche-helper --idle-timeout 0
