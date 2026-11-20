#!/usr/bin/env bash
# Psyche helper installer (linux-helper-only design 3.1, 3.3, 5.3, 6.5; task H7).
#
# Sets up the helper on a Linux computer that your Mac's Psyche will use. The helper dials your
# Gateway; nothing listens here. Run it from an unpacked psyche-helper tarball, or (after a deb or
# rpm install) as `psyche-helper-setup`.
#
#   ./install.sh                       the helper runs as YOUR account (the default; at a terminal
#                                        it asks once, --own-account skips the question)
#   sudo ./install.sh --dedicated-user [NAME]
#                                      the helper runs as its own account (default psyche-helper)
#   --ceiling default|narrow           the limits written on first install (default: default)
#                                        default: its own screen, contained commands, files under ~
#                                        narrow:  its own screen only, no commands, no files
#   --root-policy                      keep the limits in /etc/psyche-helper/policy.json, owned by
#                                        root, so neither this account nor anything the helper
#                                        starts can change them (one sudo write). Always so for
#                                        --dedicated-user and for deb/rpm installs
#   --no-linger                        do not turn on linger (the helper then runs only while the
#                                        account is logged in)
#   --uninstall [--purge]              remove the unit and the helper (--purge: also its settings,
#                                        and a dedicated account)
#
# Linger is the one step that needs an administrator: it lets the account's service manager start
# at boot with nobody logged in, which is what keeps the helper reachable. Nothing else here does.
set -euo pipefail

NAME=psyche-helper
UNIT=psyche-helper-remote.service
SLICE=psyche-machine.slice
PKG_LIB=/usr/lib/psyche-helper
ETC_POLICY=/etc/psyche-helper/policy.json

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'psyche-helper install: %s\n' "$*" >&2; exit 1; }

SELF="$(readlink -f "${BASH_SOURCE[0]}")"
SELF_DIR="$(dirname "$SELF")"

DEDICATED=0
ASKED=0
DEDICATED_NAME="$NAME"
CEILING=default
ROOT_POLICY=0
LINGER=1
UNINSTALL=0
PURGE=0
ORIG_ARGS=("$@")

while [ $# -gt 0 ]; do
  case "$1" in
    --dedicated-user)
      DEDICATED=1
      ASKED=1
      if [ $# -gt 1 ] && [[ "$2" != --* ]]; then DEDICATED_NAME="$2"; shift; fi
      ;;
    --own-account) ASKED=1 ;;
    --ceiling) [ $# -gt 1 ] || die "--ceiling needs default or narrow"; CEILING="$2"; shift ;;
    --root-policy) ROOT_POLICY=1 ;;
    --no-linger) LINGER=0 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    -h | --help) sed -n '2,/^set -euo/p' "$SELF" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (try --help)" ;;
  esac
  shift
done

case "$CEILING" in default | narrow) ;; *) die "--ceiling must be default or narrow" ;; esac
[[ "$DEDICATED_NAME" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || die "not a usable account name: $DEDICATED_NAME"
[ -d /run/systemd/system ] || die "this computer is not running systemd (WSL needs systemd=true in /etc/wsl.conf)"
command -v systemctl >/dev/null || die "systemctl not found"
command -v loginctl >/dev/null || die "loginctl not found"

# --- which files we install -------------------------------------------------------------------
if [ -x "$SELF_DIR/bin/psyche-helper" ]; then
  PAYLOAD=tarball
  SHARE="$SELF_DIR/share"
  [ -f "$SHARE/$UNIT" ] || die "$SHARE/$UNIT is missing: unpack the whole tarball"
elif [ -x "$PKG_LIB/psyche-helper" ]; then
  PAYLOAD=package
else
  die "no helper found: run this from an unpacked psyche-helper tarball, or install the deb or rpm first"
fi

# --- who runs the helper ----------------------------------------------------------------------
# At a terminal, with no choice made, ask once (design 6.5). Anywhere else the default is your account.
if [ "$ASKED" = 0 ] && [ "$UNINSTALL" = 0 ] && [ "$(id -u)" != 0 ] && [ -t 0 ] && [ -t 1 ]; then
  printf 'Run the helper as your account (%s) [Y], or as a separate "%s" account [n]? ' "$(id -un)" "$NAME"
  read -r answer || answer=""
  case "$answer" in [nN]*) DEDICATED=1 ;; esac
  ORIG_ARGS+=("$([ "$DEDICATED" = 1 ] && echo --dedicated-user || echo --own-account)")
fi

if [ "$DEDICATED" = 1 ]; then
  if [ "$(id -u)" != 0 ]; then
    command -v sudo >/dev/null || die "--dedicated-user needs root"
    exec sudo -- "$SELF" "${ORIG_ARGS[@]}"
  fi
  T_USER="$DEDICATED_NAME"
else
  [ "$(id -u)" != 0 ] || die "run this as the account the helper should use (not root), or use --dedicated-user"
  T_USER="$(id -un)"
  [ "$ROOT_POLICY" = 0 ] || [ -n "$(command -v sudo)" ] || die "--root-policy needs sudo"
fi

as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -- "$@"; fi; }

create_dedicated() {
  if getent passwd "$T_USER" >/dev/null; then
    # Never take over an account we did not make.
    getent passwd "$T_USER" | cut -d: -f5 | grep -q '^Psyche helper' ||
      die "$T_USER already exists and is not a Psyche helper account"
    return
  fi
  command -v useradd >/dev/null || die "useradd not found"
  useradd --create-home --home-dir "/home/$T_USER" --shell /usr/sbin/nologin \
    --comment "Psyche helper (lets your Mac's Psyche use this computer)" "$T_USER"
  say "created the account $T_USER (no password, no login shell)"
}

if [ "$UNINSTALL" = 0 ] && [ "$DEDICATED" = 1 ]; then create_dedicated; fi
getent passwd "$T_USER" >/dev/null || die "no account $T_USER"
T_UID="$(id -u "$T_USER")"
T_HOME="$(getent passwd "$T_USER" | cut -d: -f6)"
case "$T_HOME" in *[[:space:]]*) die "a home directory with spaces is not supported: $T_HOME" ;; esac
RUNDIR="/run/user/$T_UID"

# Run a command as the target account with its service manager's environment.
as_target() {
  if [ "$(id -un)" = "$T_USER" ]; then
    XDG_RUNTIME_DIR="$RUNDIR" DBUS_SESSION_BUS_ADDRESS="unix:path=$RUNDIR/bus" "$@"
  else
    runuser -u "$T_USER" -- env HOME="$T_HOME" XDG_RUNTIME_DIR="$RUNDIR" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=$RUNDIR/bus" "$@"
  fi
}
OWNER=()
[ "$(id -u)" = 0 ] && OWNER=(-o "$T_USER" -g "$(id -gn "$T_USER")")
# install(1) as the target account's files (root creating files for another account).
put() { install "${OWNER[@]}" "$@"; }

LIB="$T_HOME/.local/lib/$NAME"
BIN="$T_HOME/.local/bin"
UNITDIR="$T_HOME/.config/systemd/user"
CFG="$T_HOME/.config/$NAME"

linger_on() {
  [ "$LINGER" = 1 ] || return 0
  if [ -e "/var/lib/systemd/linger/$T_USER" ]; then return 0; fi
  say "turning on linger for $T_USER: this lets the helper start at boot with nobody logged in"
  if [ "$(id -u)" = 0 ]; then
    loginctl enable-linger "$T_USER"
  elif loginctl enable-linger "$T_USER" 2>/dev/null; then :
  elif [ -t 0 ] && command -v sudo >/dev/null; then
    sudo loginctl enable-linger "$T_USER"
  else
    warn "could not turn on linger. As an administrator run: loginctl enable-linger $T_USER"
    return 0
  fi
  # The user manager starts asynchronously.
  for _ in $(seq 1 50); do [ -S "$RUNDIR/bus" ] && return 0; sleep 0.2; done
  warn "the service manager for $T_USER did not come up; try again in a minute"
}

wait_manager() {
  for _ in $(seq 1 50); do [ -S "$RUNDIR/bus" ] && return 0; sleep 0.2; done
  die "no service manager for $T_USER ($RUNDIR/bus): log in once, or turn on linger (loginctl enable-linger $T_USER) and retry"
}

# --- uninstall --------------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  if [ -S "$RUNDIR/bus" ]; then
    as_target systemctl --user disable --now "$UNIT" 2>/dev/null || true
  fi
  rm -f "$UNITDIR/$UNIT" "$UNITDIR/$SLICE" "$UNITDIR/default.target.wants/$UNIT"
  rm -f "$BIN/$NAME"
  rm -rf "$LIB"
  if [ -S "$RUNDIR/bus" ]; then as_target systemctl --user daemon-reload 2>/dev/null || true; fi
  if [ "$PURGE" = 1 ]; then
    rm -rf "$CFG" "$T_HOME/.local/state/$NAME"
    if [ "$DEDICATED" = 1 ]; then
      loginctl disable-linger "$T_USER" 2>/dev/null || true
      loginctl terminate-user "$T_USER" 2>/dev/null || true
      systemctl stop "user@$T_UID.service" 2>/dev/null || true
      for _ in $(seq 1 20); do pgrep -u "$T_USER" >/dev/null 2>&1 || break; sleep 0.5; done
      userdel -r "$T_USER" 2>/dev/null || warn "could not remove the account $T_USER"
    fi
  fi
  say "removed the helper for $T_USER. $ETC_POLICY (if any) is yours to remove."
  exit 0
fi

# --- the limits -------------------------------------------------------------------------------
policy_source() {
  if [ "$PAYLOAD" = tarball ]; then
    printf '%s' "$SHARE/policy.$CEILING.json"
  else
    printf '%s' "$PKG_LIB/policy.$CEILING.json"
  fi
}

POLICY_NOTE=""
install_policy() {
  local src
  src="$(policy_source)"
  [ -f "$src" ] || die "$src is missing"
  if [ -e "$ETC_POLICY" ]; then
    POLICY_NOTE="limits: $ETC_POLICY (root-owned, kept as it is)"
    return
  fi
  if [ "$DEDICATED" = 1 ] || [ "$ROOT_POLICY" = 1 ]; then
    as_root install -d -m 0755 /etc/psyche-helper
    as_root install -o root -g root -m 0644 "$src" "$ETC_POLICY"
    POLICY_NOTE="limits: $ETC_POLICY, root-owned: the helper's account cannot change them"
    return
  fi
  local user_file="$CFG/policy.json"
  if [ -e "$user_file" ]; then
    POLICY_NOTE="limits: $user_file (kept as it is). Your account can edit it, so Psyche shows it as changeable (use --root-policy to pin it)"
    return
  fi
  put -d -m 0700 "$CFG"
  put -m 0600 "$src" "$user_file"
  POLICY_NOTE="limits: $user_file ($CEILING). Your account can edit it, so Psyche shows it as changeable (use --root-policy to pin it)"
}

# --- install ----------------------------------------------------------------------------------
if [ "$DEDICATED" = 1 ]; then
  # A dedicated account has no session: its manager needs linger before anything else.
  linger_on
fi

if [ "$PAYLOAD" = tarball ]; then
  put -d -m 0755 "$T_HOME/.local" "$T_HOME/.local/lib" "$LIB" "$BIN"
  put -d -m 0755 "$T_HOME/.config" "$T_HOME/.config/systemd" "$UNITDIR"
  tmp="$LIB/.psyche-helper.install"
  put -m 0755 "$SELF_DIR/bin/psyche-helper" "$tmp"
  mv -f "$tmp" "$LIB/psyche-helper"
  ln -sfn "$LIB/psyche-helper" "$BIN/$NAME"
  [ "$(id -u)" = 0 ] && chown -h "$T_USER:$(id -gn "$T_USER")" "$BIN/$NAME"
  # The unit runs the copy under the account's home.
  rendered="$(mktemp)"
  sed "s#^ExecStart=/usr/bin/psyche-helper #ExecStart=$LIB/psyche-helper #" "$SHARE/$UNIT" >"$rendered"
  grep -q "^ExecStart=$LIB/psyche-helper remote" "$rendered" || die "could not set the unit's ExecStart"
  put -m 0644 "$rendered" "$UNITDIR/$UNIT"
  rm -f "$rendered"
  put -m 0644 "$SHARE/$SLICE" "$UNITDIR/$SLICE"
  EXEC_PATH="$LIB/psyche-helper"
else
  EXEC_PATH="/usr/bin/psyche-helper"
fi

install_policy

if [ "$DEDICATED" = 0 ]; then linger_on; fi
wait_manager
as_target systemctl --user daemon-reload
as_target systemctl --user enable "$UNIT" >/dev/null

if [ "$DEDICATED" = 1 ]; then
  RUN_AS="sudo -u $T_USER -H env XDG_RUNTIME_DIR=$RUNDIR"
  CTL="sudo -u $T_USER -H env XDG_RUNTIME_DIR=$RUNDIR systemctl --user"
else
  RUN_AS=""
  CTL="systemctl --user"
fi

cat <<EOF

The Psyche helper is installed for the account "$T_USER" and set to start at boot.
  program: $EXEC_PATH
  $POLICY_NOTE

Next, on your Mac: Settings > Devices > Computers Psyche can use > Add. Then here:
  $RUN_AS $EXEC_PATH pair -
(paste the link it gives you), and start the service:
  $CTL start $UNIT
  $CTL status $UNIT
EOF
if [ "$PAYLOAD" = tarball ]; then
  say "Update later with: $RUN_AS $EXEC_PATH update"
else
  say "Update with your package manager (apt, dnf)."
fi
