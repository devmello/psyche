#!/usr/bin/env bash
# Psyche helper installer (linux-helper-only design 3.1, 3.3, 5.3, 6.5; task H7).
#
# Sets up the helper on a Linux computer that your Mac's Psyche will use. The helper dials your
# Gateway; nothing listens here. Run it from an unpacked psyche-helper tarball, or (after a deb or
# rpm install) as `psyche-helper-setup`.
#
#   ./install.sh                       the helper runs as YOUR account (the default; at a terminal
#                                        it asks once, --own-account skips the question). The
#                                        program and its settings live in your home
#   sudo ./install.sh --dedicated-user [NAME]
#                                      the helper runs as its own account (default psyche-helper).
#                                        The program is root's (/usr/local/lib/psyche-helper), its
#                                        service file is root's (/etc/systemd/user) and so is the
#                                        limits file. Root's file limits what the agent reaches; it is
#                                        not enforced against the account's own processes, so Psyche
#                                        still shows the limits as user-owned
#   --ceiling default|narrow           the limits written on first install (default: default)
#                                        default: its own screen, contained commands, files under ~
#                                        narrow:  apps only, no commands and no files
#   --root-policy                      keep the limits in /etc/psyche-helper/policy.json, owned by
#                                        root (one sudo write). On an own-account tarball install
#                                        the program still lives in your home, which your account
#                                        can change, so Psyche shows the limits as changeable. Always
#                                        root's for --dedicated-user and for deb/rpm installs
#   --no-linger                        do not turn on linger (the helper then runs only while the
#                                        account is logged in)
#   --uninstall [--purge]              remove the helper (--purge: also its settings, and a
#                                        dedicated account)
#
# Linger is the one step that needs an administrator: it lets the account's service manager start
# at boot with nobody logged in, which is what keeps the helper reachable.
#
# Whatever runs as root here touches only root-owned paths. Everything in an account's home is
# written and removed by that account itself, so a link it planted there leads nowhere with root's
# rights.
set -euo pipefail

NAME=psyche-helper
UNIT=psyche-helper-remote.service
SLICE=psyche-machine.slice
PKG_LIB=/usr/lib/psyche-helper
ROOT_LIB=/usr/local/lib/psyche-helper
ROOT_BIN=/usr/local/bin/psyche-helper
ROOT_UNITDIR=/etc/systemd/user
ETC_POLICY=/etc/psyche-helper/policy.json
# Written (root-owned) when this installer makes or adopts the dedicated account. --purge deletes an
# account and its home only if this names it, so a wrong NAME can never remove somebody's home.
STATE_DIR=/var/lib/psyche-helper
MARKER="$STATE_DIR/dedicated-account"

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

# At a terminal, with no choice made, ask once (design 6.5). Anywhere else the default is your account.
if [ "$ASKED" = 0 ] && [ "$UNINSTALL" = 0 ] && [ "$(id -u)" != 0 ] && [ -t 0 ] && [ -t 1 ]; then
  printf 'Run the helper as your account (%s) [Y], or as a separate "%s" account [n]? ' "$(id -un)" "$NAME"
  read -r answer || answer=""
  case "$answer" in [nN]*) DEDICATED=1 ;; esac
  ORIG_ARGS+=("$([ "$DEDICATED" = 1 ] && echo --dedicated-user || echo --own-account)")
fi

# --- who runs the helper ----------------------------------------------------------------------
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

# Does NAME look like the account this installer makes: a "Psyche helper" description and no login shell?
is_helper_account() {
  local entry
  entry="$(getent passwd "$1")" || return 1
  [ "$(printf '%s' "$entry" | cut -d: -f5 | cut -c1-13)" = "Psyche helper" ] || return 1
  case "$(printf '%s' "$entry" | cut -d: -f7)" in */nologin | */false) return 0 ;; esac
  return 1
}
write_marker() {
  as_root install -d -m 0755 -o root -g root "$STATE_DIR"
  printf '%s\n' "$T_USER" | as_root tee "$MARKER" >/dev/null
  as_root chmod 0644 "$MARKER"
}
marked_account() { [ -f "$MARKER" ] && [ ! -L "$MARKER" ] && [ "$(head -n 1 "$MARKER")" = "$T_USER" ]; }

create_dedicated() {
  if getent passwd "$T_USER" >/dev/null; then
    # Never take over an account we did not make.
    is_helper_account "$T_USER" || die "$T_USER already exists and is not a Psyche helper account"
    write_marker
    return
  fi
  command -v useradd >/dev/null || die "useradd not found"
  useradd --create-home --home-dir "/home/$T_USER" --shell /usr/sbin/nologin \
    --comment "Psyche helper (lets your Mac's Psyche use this computer)" "$T_USER"
  write_marker
  say "created the account $T_USER (no password, no login shell)"
}

# One helper account per machine for the tarball (the root-owned service file names it), and never a
# tarball dedicated install next to a deb or rpm one (the /etc service file would shadow the packaged one).
ETC_UNIT="$ROOT_UNITDIR/$UNIT"
etc_unit_user() { sed -n 's/^ConditionUser=//p' "$ETC_UNIT" 2>/dev/null | head -n 1; }
if [ "$UNINSTALL" = 0 ]; then
  if [ "$DEDICATED" = 1 ] && [ "$PAYLOAD" = tarball ] && [ -x "$PKG_LIB/psyche-helper" ]; then
    die "the deb or rpm is installed: use psyche-helper-setup --dedicated-user, not this tarball"
  fi
  if [ "$DEDICATED" = 1 ] && [ -e "$ETC_UNIT" ] && [ "$(etc_unit_user)" != "$T_USER" ]; then
    die "another account ($(etc_unit_user)) already runs the helper through $ETC_UNIT: remove it first"
  fi
  if [ "$PAYLOAD" = package ] && [ -e "$ETC_UNIT" ]; then
    die "a tarball dedicated install ($ETC_UNIT) is here and would shadow the package's service file: remove it first (install.sh --dedicated-user NAME --uninstall)"
  fi
fi
if [ "$UNINSTALL" = 0 ] && [ "$DEDICATED" = 1 ]; then create_dedicated; fi
# An account deleted by hand leaves root's files behind (and they refuse any new dedicated install):
# uninstalling for that name still removes them. Nothing of the account's is left to remove.
if [ "$UNINSTALL" = 1 ] && [ "$DEDICATED" = 1 ] && ! getent passwd "$T_USER" >/dev/null &&
  [ "$(etc_unit_user)" = "$T_USER" ]; then
  # A helper started before the account went is still running from memory under its old UID, kept
  # alive by that UID's user manager. Stop the manager of any UID that runs it and has no account now.
  for pid in $(pgrep -f "$ROOT_LIB/psyche-helper" 2>/dev/null || true); do
    stale_uid="$(ps -o uid= -p "$pid" 2>/dev/null | tr -d ' ')"
    [ -n "$stale_uid" ] && [ "$stale_uid" != 0 ] || continue
    getent passwd "$stale_uid" >/dev/null && continue
    as_root systemctl stop "user@$stale_uid.service" 2>/dev/null || true
    as_root kill "$pid" 2>/dev/null || true
  done
  # Linger would otherwise start a manager for any future account of the same name.
  as_root rm -f "/var/lib/systemd/linger/$T_USER"
  as_root rm -f "$ROOT_UNITDIR/$UNIT" "$ROOT_UNITDIR/$SLICE" "$ROOT_BIN"
  as_root rm -rf "$ROOT_LIB"
  if marked_account; then as_root rm -f "$MARKER"; fi
  say "the account $T_USER is gone; removed its service file, program and linger"
  exit 0
fi
getent passwd "$T_USER" >/dev/null || die "no account $T_USER"
T_UID="$(id -u "$T_USER")"
T_HOME="$(getent passwd "$T_USER" | cut -d: -f6)"
case "$T_HOME" in *[[:space:]]*) die "a home directory with spaces is not supported: $T_HOME" ;; esac
RUNDIR="/run/user/$T_UID"

# Run a command AS the target account (never as root) with its service manager's environment.
# Everything that reads or writes under its home goes through here.
as_target() {
  if [ "$(id -un)" = "$T_USER" ]; then
    XDG_RUNTIME_DIR="$RUNDIR" DBUS_SESSION_BUS_ADDRESS="unix:path=$RUNDIR/bus" "$@"
  else
    # Never on the administrator's own terminal: a process of that account could otherwise push
    # keystrokes into the admin's shell. A pseudo-terminal of its own, or no terminal at all.
    if runuser --help 2>&1 | grep -q -- '--pty'; then
      runuser -u "$T_USER" --pty -- env HOME="$T_HOME" XDG_RUNTIME_DIR="$RUNDIR" \
        DBUS_SESSION_BUS_ADDRESS="unix:path=$RUNDIR/bus" "$@"
    else
      setsid -w runuser -u "$T_USER" -- env HOME="$T_HOME" XDG_RUNTIME_DIR="$RUNDIR" \
        DBUS_SESSION_BUS_ADDRESS="unix:path=$RUNDIR/bus" "$@" </dev/null
    fi
  fi
}

LIB="$T_HOME/.local/lib/$NAME"
BIN="$T_HOME/.local/bin"
UNITDIR="$T_HOME/.config/systemd/user"
CFG="$T_HOME/.config/$NAME"

# The own-account tarball keeps everything in the home; a dedicated account's program and unit are root's.
if [ "$PAYLOAD" = package ]; then
  EXEC_PATH=/usr/bin/psyche-helper
elif [ "$DEDICATED" = 1 ]; then
  EXEC_PATH="$ROOT_LIB/psyche-helper"
else
  EXEC_PATH="$LIB/psyche-helper"
fi

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
  # --purge deletes the account and its home: only for an account this installer made. Refuse before
  # anything is touched.
  if [ "$PURGE" = 1 ] && [ "$DEDICATED" = 1 ]; then
    if ! marked_account || ! is_helper_account "$T_USER"; then
      die "$T_USER is not a Psyche helper account that this installer created; not removing it (nothing was changed). Remove the account yourself if you mean to."
    fi
  fi
  if [ -S "$RUNDIR/bus" ]; then
    as_target systemctl --user disable --now "$UNIT" 2>/dev/null || true
  fi
  # Root's own files (a dedicated account's program and service file) ...
  if [ "$DEDICATED" = 1 ] && [ "$(etc_unit_user)" = "$T_USER" ]; then
    rm -f "$ROOT_UNITDIR/$UNIT" "$ROOT_UNITDIR/$SLICE" "$ROOT_BIN"
    rm -rf "$ROOT_LIB"
  fi
  # ... and the account's, removed by the account.
  as_target rm -f "$UNITDIR/$UNIT" "$UNITDIR/$SLICE" "$UNITDIR/default.target.wants/$UNIT" "$BIN/$NAME" || warn "could not remove some of the account's files"
  as_target rm -rf "$LIB" || warn "could not remove $LIB"
  if [ -S "$RUNDIR/bus" ]; then as_target systemctl --user daemon-reload 2>/dev/null || true; fi
  if [ "$PURGE" = 1 ]; then
    as_target rm -rf "$CFG" "$T_HOME/.local/state/$NAME" || warn "could not remove the account's settings"
    if [ "$DEDICATED" = 1 ]; then
      loginctl disable-linger "$T_USER" 2>/dev/null || true
      loginctl terminate-user "$T_USER" 2>/dev/null || true
      systemctl stop "user@$T_UID.service" 2>/dev/null || true
      for _ in $(seq 1 20); do pgrep -u "$T_USER" >/dev/null 2>&1 || break; sleep 0.5; done
      if userdel -r "$T_USER" 2>/dev/null; then as_root rm -f "$MARKER"; else warn "could not remove the account $T_USER"; fi
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

# A directory that does not exist yet, made private. One that exists is left exactly as it is.
mkdir_private() {
  local d
  for d in "$@"; do [ -d "$d" ] || install -d -m 0700 "$d"; done
}

POLICY_NOTE=""
install_policy() {
  local src
  src="$(policy_source)"
  if [ ! -f "$src" ] || [ -L "$src" ]; then die "$src is missing"; fi
  if [ -e "$ETC_POLICY" ]; then
    POLICY_NOTE="limits: $ETC_POLICY (root-owned, kept as it is)"
    return
  fi
  if [ "$DEDICATED" = 1 ] || [ "$ROOT_POLICY" = 1 ]; then
    as_root install -d -m 0755 -o root -g root /etc/psyche-helper
    as_root install -o root -g root -m 0644 "$src" "$ETC_POLICY"
    if [ "$DEDICATED" = 1 ] || [ "$PAYLOAD" = package ]; then
      POLICY_NOTE="limits: $ETC_POLICY, root's file. It limits what the agent reaches but is not enforced against the account's own processes, so Psyche shows the limits as user-owned"
    else
      POLICY_NOTE="limits: $ETC_POLICY, root's file. The program runs from your home, which this account can change, so Psyche shows the limits as user-owned"
    fi
    return
  fi
  local user_file="$CFG/policy.json"
  if [ -e "$user_file" ]; then
    POLICY_NOTE="limits: $user_file (kept as it is). Your account can edit it, so Psyche shows it as changeable (use --root-policy to pin it)"
    return
  fi
  mkdir_private "$T_HOME/.config" "$CFG"
  install -m 0600 "$src" "$user_file"
  POLICY_NOTE="limits: $user_file ($CEILING). Your account can edit it, so Psyche shows it as changeable (use --root-policy to pin it)"
}

# --- install ----------------------------------------------------------------------------------
if [ "$DEDICATED" = 1 ]; then
  # A dedicated account has no session: its manager needs linger before anything else.
  linger_on
fi

render_unit() { # render_unit EXEC_PATH -> stdout
  if [ "$DEDICATED" = 1 ]; then
    # The file is in /etc, which every account's manager reads: only this account's runs it.
    sed -e "s#^ExecStart=/usr/bin/psyche-helper #ExecStart=$1 #" -e "s#^\[Unit\]\$#[Unit]\nConditionUser=$T_USER#" "$SHARE/$UNIT"
  else
    sed "s#^ExecStart=/usr/bin/psyche-helper #ExecStart=$1 #" "$SHARE/$UNIT"
  fi
}

if [ "$PAYLOAD" = tarball ]; then
  for f in "$SELF_DIR/bin/psyche-helper" "$SHARE/$UNIT" "$SHARE/$SLICE"; do
    if [ ! -f "$f" ] || [ -L "$f" ]; then die "$f is not a regular file"; fi
  done
  rendered="$(mktemp)"
  render_unit "$EXEC_PATH" >"$rendered"
  grep -q "^ExecStart=$EXEC_PATH remote" "$rendered" || die "could not set the unit's ExecStart"
  if [ "$DEDICATED" = 1 ]; then
    # Root-owned program and service file, written by root into root-owned places only.
    for d in "$ROOT_LIB" "$ROOT_UNITDIR" /usr/local/bin; do
      [ -d "$d" ] || install -d -m 0755 -o root -g root "$d"
    done
    install -o root -g root -m 0755 "$SELF_DIR/bin/psyche-helper" "$ROOT_LIB/.psyche-helper.install"
    mv -f "$ROOT_LIB/.psyche-helper.install" "$ROOT_LIB/psyche-helper"
    ln -sfn "$ROOT_LIB/psyche-helper" "$ROOT_BIN"
    install -o root -g root -m 0644 "$rendered" "$ROOT_UNITDIR/$UNIT"
    install -o root -g root -m 0644 "$SHARE/$SLICE" "$ROOT_UNITDIR/$SLICE"
  else
    # Our own account, our own files: nothing here runs with more rights than the owner has.
    mkdir_private "$T_HOME/.local" "$T_HOME/.local/lib" "$LIB" "$BIN" \
      "$T_HOME/.config" "$T_HOME/.config/systemd" "$UNITDIR"
    install -m 0755 "$SELF_DIR/bin/psyche-helper" "$LIB/.psyche-helper.install"
    mv -f "$LIB/.psyche-helper.install" "$LIB/psyche-helper"
    ln -sfn "$LIB/psyche-helper" "$BIN/$NAME"
    install -m 0644 "$rendered" "$UNITDIR/$UNIT"
    install -m 0644 "$SHARE/$SLICE" "$UNITDIR/$SLICE"
  fi
  rm -f "$rendered"
fi

install_policy

if [ "$DEDICATED" = 0 ]; then linger_on; fi
wait_manager
as_target systemctl --user daemon-reload
as_target systemctl --user enable "$UNIT" >/dev/null
# A running helper is still the old program (and would report it as deleted): start it again.
if [ "$DEDICATED" = 1 ] && [ "$PAYLOAD" = tarball ]; then
  as_target systemctl --user try-restart "$UNIT" || warn "could not restart the running helper; as $T_USER run: systemctl --user restart $UNIT"
fi

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
if [ "$PAYLOAD" = package ]; then
  say "Update with your package manager (apt, dnf)."
elif [ "$DEDICATED" = 1 ]; then
  say "Update later by unpacking the new release and running: sudo ./install.sh --dedicated-user $T_USER"
else
  say "Update later with: $EXEC_PATH update"
fi
