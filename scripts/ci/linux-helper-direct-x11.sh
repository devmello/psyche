#!/usr/bin/env bash
# Direct computer use on the X11 path, end to end (linux-desktop design §6.4, L5): Xvfb, openbox
# (an EWMH window manager), a private session bus with the real at-spi bus, and a GTK 4 app. The
# helper's engine snapshots it, types into it and reads the text back through AT-SPI. Needs
# xvfb, openbox, at-spi2-core, dbus and gnome-text-editor (apps/linux-helper/ci-deps.txt).
set -euo pipefail
cd "$(dirname "$0")/../../apps/linux-helper"

for tool in Xvfb xprop openbox dbus-run-session gnome-text-editor; do
  command -v "$tool" >/dev/null || { echo "linux-helper-direct-x11: $tool is required" >&2; exit 2; }
done

# A free display number, so two runs never share a server (a lock file, or a live abstract socket).
display=99
while [ -e "/tmp/.X${display}-lock" ] || [ -e "/tmp/.X11-unix/X${display}" ] || DISPLAY=":${display}" xprop -root >/dev/null 2>&1; do display=$((display + 1)); done
export DISPLAY=":${display}"
unset WAYLAND_DISPLAY XDG_SESSION_TYPE
export GDK_BACKEND=x11 GSETTINGS_BACKEND=memory NO_AT_BRIDGE=0 GTK_A11Y=atspi

Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
xvfb=$!
cleanup() { kill "$xvfb" 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 1 100); do xprop -root >/dev/null 2>&1 && break; sleep 0.1; done
xprop -root >/dev/null 2>&1 || { echo "linux-helper-direct-x11: Xvfb did not start" >&2; exit 1; }

dbus-run-session -- bash -c '
  set -euo pipefail
  openbox >/dev/null 2>&1 &
  gnome-text-editor --new-window >/dev/null 2>&1 &
  sleep 2
  PSYCHE_E2E_X11=1 cargo test -p psyche-linux-computer --test x11_e2e -- --ignored --nocapture --test-threads=1
'
