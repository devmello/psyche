#!/usr/bin/env bash
# End-to-end check of the helper-only package, install and update on a Linux machine with systemd
# (H7). Meant for a throwaway VM, NEVER the Mac and never a computer you use: it creates and
# removes accounts named psyche-h7-*, installs and removes the deb, and writes /etc/psyche-helper.
#
#   bash deploy/linux-helper/test/vm-test.sh <repo-root> [--skip-build]
#
# Needs: sudo without a password, cargo, node, zstd, dpkg-deb, rpmbuild, systemd-analyze.
# Prints PASS/FAIL per check and exits non-zero on any FAIL.
# shellcheck disable=SC2015,SC2024
set -uo pipefail

REPO="$(cd "${1:?usage: vm-test.sh <repo-root> [--skip-build]}" && pwd -P)"
SKIP_BUILD=0
[ "${2:-}" = "--skip-build" ] && SKIP_BUILD=1
DIR="$REPO/deploy/linux-helper"
W="${H7_WORK:-/tmp/psyche-h7-work}"
USERS=(psyche-h7-own psyche-h7-ded psyche-h7-pkg psyche-h7-upd)
PASS=0 FAIL=0
CREATED_ETC=0

ok() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$*"; }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }
refuse() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then bad "$name (should have failed)"; else ok "$name"; fi; }
uid_of() { id -u "$1"; }
as() { # as USER cmd...
  local u="$1"; shift
  sudo -u "$u" -H env XDG_RUNTIME_DIR="/run/user/$(uid_of "$u")" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(uid_of "$u")/bus" "$@"
}
ctl() { local u="$1"; shift; as "$u" systemctl --user "$@"; }
wait_for() { # wait_for SECONDS cmd...
  local n="$1"; shift
  for _ in $(seq 1 $((n * 2))); do "$@" >/dev/null 2>&1 && return 0; sleep 0.5; done
  return 1
}
sock() { sudo test -S "/run/user/$1/bus"; }
export -f uid_of as ctl wait_for sock

cleanup() {
  for u in "${USERS[@]}"; do
    if id "$u" >/dev/null 2>&1; then
      n="$(id -u "$u")"
      sudo loginctl disable-linger "$u" >/dev/null 2>&1
      sudo loginctl terminate-user "$u" >/dev/null 2>&1
      sudo systemctl stop "user@$n.service" >/dev/null 2>&1
      sudo pkill -u "$u" >/dev/null 2>&1
      sleep 1
      sudo userdel -r "$u" >/dev/null 2>&1
    fi
  done
  sudo dpkg -P psyche-helper >/dev/null 2>&1
  sudo rm -f /etc/sudoers.d/psyche-h7
  [ "$CREATED_ETC" = 1 ] && sudo rm -rf /etc/psyche-helper
  sudo rm -rf "$W-root"
}
trap cleanup EXIT

if [ -e /etc/psyche-helper/policy.json ]; then
  echo "refusing to run: /etc/psyche-helper/policy.json exists on this machine" >&2
  exit 2
fi
CREATED_ETC=1
for u in "${USERS[@]}"; do id "$u" >/dev/null 2>&1 && { echo "refusing to run: account $u exists" >&2; exit 2; }; done
rm -rf "$W"; mkdir -p "$W"; chmod 755 "$W"

# --- build ------------------------------------------------------------------------------------
NODE="$(command -v node)"
KEY="$W/release-key.pem"
PUB="$("$NODE" "$REPO/deploy/scripts/update-manifest.mjs" keygen "$KEY" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).publicKey))')"
OTHER_KEY="$W/other-key.pem"
"$NODE" "$REPO/deploy/scripts/update-manifest.mjs" keygen "$OTHER_KEY" >/dev/null
ARCH=x64; [ "$(uname -m)" = aarch64 ] && ARCH=arm64

build_real() { # build_real VERSION OUTDIR
  (cd "$REPO/apps/linux-helper" &&
    PSYCHE_RELEASE_VERSION="$1" PSYCHE_HELPER_TEST_RELEASE_KEY="$PUB" CARGO_PROFILE_DEV_DEBUG=0 \
      CARGO_BUILD_JOBS=3 nice cargo build -p psyche-helper --locked 2>&1 | tail -2) || return 1
  mkdir -p "$2"; cp "$REPO/apps/linux-helper/target/debug/psyche-helper" "$2/psyche-helper"
}
if [ "$SKIP_BUILD" = 0 ]; then
  build_real 0.1.0 "$W/bin1" && build_real 0.2.0 "$W/bin2" || { echo "build failed"; exit 2; }
fi
[ -x "$W/bin1/psyche-helper" ] && [ -x "$W/bin2/psyche-helper" ] || { echo "no binaries in $W"; exit 2; }

# A stand-in helper for the install checks: answers --build-info, and `remote` just stays up.
stub() { # stub VERSION OUTDIR
  mkdir -p "$2"
  cat >"$2/psyche-helper" <<EOF
#!/bin/sh
case "\$1" in
  --build-info) echo '{"name":"psyche-helper","version":"$1"}' ;;
  remote) exec sleep infinity ;;
  *) exit 0 ;;
esac
EOF
  chmod 755 "$2/psyche-helper"
}
stub 0.1.0 "$W/stub1"
stub 0.3.0 "$W/stub3"

mkdir -p "$W/pk-stub" "$W/pk-real1" "$W/pk-real2" "$W/pk-stub3"
bash "$DIR/build-packages.sh" --version 0.1.0 --arch "$ARCH" --binary "$W/stub1/psyche-helper" --out "$W/pk-stub" >/dev/null && ok "packages build (stub 0.1.0)" || bad "packages build (stub)"
bash "$DIR/build-packages.sh" --version 0.1.0 --arch "$ARCH" --binary "$W/bin1/psyche-helper" --out "$W/pk-real1" >/dev/null && ok "packages build (real 0.1.0)" || bad "packages build (real 0.1.0)"
bash "$DIR/build-packages.sh" --version 0.2.0 --arch "$ARCH" --binary "$W/bin2/psyche-helper" --out "$W/pk-real2" >/dev/null && ok "packages build (real 0.2.0)" || bad "packages build (real 0.2.0)"
bash "$DIR/build-packages.sh" --version 0.3.0 --arch "$ARCH" --binary "$W/stub3/psyche-helper" --out "$W/pk-stub3" >/dev/null && ok "packages build (stub 0.3.0)" || bad "packages build (stub 0.3.0)"
# Same inputs, same bytes.
bash "$DIR/build-packages.sh" --version 0.1.0 --arch "$ARCH" --binary "$W/stub1/psyche-helper" --out "$W/pk-stub-again" >/dev/null 2>&1
for ext in tar.zst deb; do
  check "$ext is reproducible" cmp "$W/pk-stub/psyche-helper-0.1.0-linux-$ARCH.$ext" "$W/pk-stub-again/psyche-helper-0.1.0-linux-$ARCH.$ext"
done

TAR="psyche-helper-0.1.0-linux-$ARCH.tar.zst"
DEB="$W/pk-real1/psyche-helper-0.1.0-linux-$ARCH.deb"
RPM="$W/pk-real1/psyche-helper-0.1.0-linux-$ARCH.rpm"

# --- package contents -------------------------------------------------------------------------
check "deb: control names the runtime dependencies" bash -c "dpkg-deb -f '$DEB' Depends | grep -q bubblewrap && dpkg-deb -f '$DEB' Depends | grep -q dbus-user-session && dpkg-deb -f '$DEB' Depends | grep -q xvfb"
check "deb: lists the unit, the binary and the policy conffile" bash -c "dpkg-deb -c '$DEB' | grep -q usr/lib/systemd/user/psyche-helper-remote.service && dpkg-deb -c '$DEB' | grep -q usr/lib/psyche-helper/psyche-helper && dpkg-deb -I '$DEB' | grep -q . && dpkg-deb -e '$DEB' '$W/debctl' && grep -q policy.json '$W/debctl/conffiles'"
check "deb: every file is owned by root" bash -c "! dpkg-deb -c '$DEB' | awk '{print \$2}' | grep -qv '^root/root$'"
check "rpm: lists the unit, the binary and a noreplace policy" bash -c "rpm -qpl '$RPM' | grep -q /usr/lib/systemd/user/psyche-helper-remote.service && rpm -qpc '$RPM' | grep -q /etc/psyche-helper/policy.json"
check "rpm: requires the runtime dependencies" bash -c "rpm -qpR '$RPM' | grep -q bubblewrap && rpm -qpR '$RPM' | grep -q Xvfb"
check "tarball: has install.sh, the binary, the unit and both ceilings" bash -c "tar --zstd -tf '$W/pk-stub/$TAR' | grep -q '/install.sh' && tar --zstd -tf '$W/pk-stub/$TAR' | grep -q '/bin/psyche-helper' && tar --zstd -tf '$W/pk-stub/$TAR' | grep -q 'share/policy.narrow.json'"

# --- systemd-analyze verify -------------------------------------------------------------------
sudo dpkg -i --force-depends "$DEB" >/dev/null 2>&1 && ok "deb installs" || bad "deb installs"
check "systemd-analyze verify: the packaged unit and slice" systemd-analyze verify --user /usr/lib/systemd/user/psyche-helper-remote.service /usr/lib/systemd/user/psyche-machine.slice
check "deb: policy.json is root-owned and not writable by others" bash -c "[ \"\$(stat -c '%U:%a' /etc/psyche-helper/policy.json)\" = root:644 ]"

# --- package mode (deb), one account ----------------------------------------------------------
sudo useradd -m -s /bin/bash psyche-h7-pkg
sudo loginctl enable-linger psyche-h7-pkg
wait_for 20 sock "$(uid_of psyche-h7-pkg)" || bad "pkg: user manager did not start"
as psyche-h7-pkg /usr/bin/psyche-helper-setup >"$W/pkg-setup.log" 2>&1 && ok "package mode: psyche-helper-setup" || { bad "package mode: psyche-helper-setup"; cat "$W/pkg-setup.log"; }
check "package mode: the unit is enabled for the account" bash -c "ctl psyche-h7-pkg is-enabled psyche-helper-remote.service"
check "package mode: the policy stays the root-owned one" grep -q "root-owned" "$W/pkg-setup.log"
check "package mode: nothing was written into the account's config" sudo bash -c "[ ! -e /home/psyche-h7-pkg/.config/psyche-helper/policy.json ]"
as psyche-h7-pkg /usr/bin/psyche-helper update >"$W/pkg-update.log" 2>&1
check "package mode: update defers to the package manager" grep -q "package manager" "$W/pkg-update.log"
sudo dpkg -r psyche-helper >/dev/null 2>&1; check "deb: remove keeps the policy (conffile)" test -f /etc/psyche-helper/policy.json
sudo dpkg -P psyche-helper >/dev/null 2>&1; check "deb: purge removes the policy" bash -c "[ ! -e /etc/psyche-helper/policy.json ]"

# --- own account (tarball), the default -------------------------------------------------------
sudo useradd -m -s /bin/bash psyche-h7-own
OWN=psyche-h7-own; OWN_UID="$(uid_of $OWN)"
mkdir -p "$W/own" && tar --zstd -xf "$W/pk-stub/$TAR" -C "$W/own" && chmod -R a+rX "$W/own"
INST="$W/own/psyche-helper-0.1.0-linux-$ARCH/install.sh"
H="/home/$OWN"
refuse "own account: refuses to run as root" sudo bash "$INST"
# Directories the owner already has stay exactly as they are (the installer only creates missing ones).
sudo -u $OWN mkdir -m 0700 "$H/.config" "$H/.local"
sudo -u $OWN mkdir -m 0750 "$H/.config/systemd"
as $OWN bash "$INST" >"$W/own-1.log" 2>&1
check "own account: an existing 0700 ~/.config, 0700 ~/.local and 0750 ~/.config/systemd keep their modes" sudo bash -c "[ \"\$(stat -c %a $H/.config)\" = 700 ] && [ \"\$(stat -c %a $H/.local)\" = 700 ] && [ \"\$(stat -c %a $H/.config/systemd)\" = 750 ]"
check "own account: directories it created are private (0700)" sudo bash -c "[ \"\$(stat -c %a $H/.config/systemd/user)\" = 700 ] && [ \"\$(stat -c %a $H/.local/lib/psyche-helper)\" = 700 ]"
check "own account: the installer turns linger on and says why" grep -q "turning on linger for $OWN: this lets the helper start at boot" "$W/own-1.log"
wait_for 20 sock "$OWN_UID" || bad "own: user manager did not start"
as $OWN bash "$INST" >"$W/own-2.log" 2>&1 && ok "own account: installer, second run (idempotent)" || { bad "own account: installer"; cat "$W/own-2.log"; }
check "own account: binary, symlink, unit and slice are in the account's home" sudo bash -c "[ -x $H/.local/lib/psyche-helper/psyche-helper ] && [ -L $H/.local/bin/psyche-helper ] && [ -f $H/.config/systemd/user/psyche-helper-remote.service ] && [ -f $H/.config/systemd/user/psyche-machine.slice ]"
check "own account: the unit runs the installed copy" sudo grep -q "^ExecStart=$H/.local/lib/psyche-helper/psyche-helper remote" "$H/.config/systemd/user/psyche-helper-remote.service"
check "own account: files belong to the account" sudo bash -c "[ \"\$(stat -c %U $H/.local/lib/psyche-helper/psyche-helper)\" = $OWN ]"
check "own account: the default ceiling is written 0600 and says it is changeable" sudo bash -c "[ \"\$(stat -c %a $H/.config/psyche-helper/policy.json)\" = 600 ] && grep -q '\"enabled\": true' $H/.config/psyche-helper/policy.json && grep -q changeable $W/own-2.log"
check "own account: no root-owned policy was created" bash -c "[ ! -e /etc/psyche-helper/policy.json ]"
check "systemd-analyze verify: the rendered unit" as $OWN systemd-analyze verify --user "$H/.config/systemd/user/psyche-helper-remote.service" "$H/.config/systemd/user/psyche-machine.slice"
check "own account: linger is on" test -e "/var/lib/systemd/linger/$OWN"
ctl $OWN start psyche-helper-remote.service
check "own account: the helper is running as the account" bash -c "wait_for 10 ctl $OWN is-active --quiet psyche-helper-remote.service && [ \"\$(ps -o user= -p \$(ctl $OWN show -p MainPID --value psyche-helper-remote.service))\" = $OWN ]"
check "own account: NoNewPrivileges is on for the service" bash -c "grep -q 'NoNewPrivs:.1' /proc/\$(ctl $OWN show -p MainPID --value psyche-helper-remote.service)/status"
PID1="$(ctl $OWN show -p MainPID --value psyche-helper-remote.service)"
# A reboot: the user manager goes away with the machine and logind starts it again for a lingering
# account. (The shared VM is not rebooted; this stops and starts the same unit logind uses.)
sudo systemctl stop "user@$OWN_UID.service"
check "reboot (simulated): the helper is gone with the user manager" bash -c "! kill -0 $PID1 2>/dev/null"
sudo systemctl start "user@$OWN_UID.service"
wait_for 20 sock "$OWN_UID"
check "reboot (simulated): the helper is back, a new process, with nobody logged in" bash -c "wait_for 20 ctl $OWN is-active --quiet psyche-helper-remote.service && [ \"\$(ctl $OWN show -p MainPID --value psyche-helper-remote.service)\" != $PID1 ] && ! loginctl list-sessions --no-legend | grep -q ' $OWN '"
# The same restart without linger does not happen: the contrast that shows linger is what does it.
as $OWN bash "$INST" --ceiling narrow >"$W/own-3.log" 2>&1
check "own account: running the installer again keeps the limits it wrote" grep -q "kept as it is" "$W/own-3.log"
as $OWN bash "$INST" --uninstall >/dev/null 2>&1
check "own account: --uninstall removes the unit and the helper, keeps the settings" sudo bash -c "[ ! -e $H/.local/lib/psyche-helper ] && [ ! -e $H/.config/systemd/user/psyche-helper-remote.service ] && [ -e $H/.config/psyche-helper/policy.json ]"

# At a terminal with no choice made, the installer asks once; "y" (or Enter) keeps the own account.
printf 'y\n' | as $OWN script -qec "bash $INST" /dev/null >"$W/own-ask.log" 2>&1
check "own account: at a terminal the installer asks which account, and y keeps the own account" bash -c "grep -q 'Run the helper as your account' $W/own-ask.log && grep -q 'installed for the account \"$OWN\"' $W/own-ask.log"

# --- own account with --root-policy -----------------------------------------------------------
as $OWN bash "$INST" --uninstall --purge >/dev/null 2>&1
echo "$OWN ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/psyche-h7 >/dev/null
sudo chmod 440 /etc/sudoers.d/psyche-h7
as $OWN bash "$INST" --root-policy --ceiling narrow >"$W/own-4.log" 2>&1 && ok "own account: --root-policy installer" || { bad "own account: --root-policy"; cat "$W/own-4.log"; }
check "own account + --root-policy: the limits are root-owned and the account has no copy of its own" sudo bash -c "[ \"\$(stat -c %U:%a /etc/psyche-helper/policy.json)\" = root:644 ] && [ ! -e $H/.config/psyche-helper/policy.json ] && grep -q '\"enabled\": false' /etc/psyche-helper/policy.json"
as $OWN bash "$INST" --uninstall --purge >/dev/null 2>&1
sudo rm -f /etc/sudoers.d/psyche-h7
sudo rm -rf /etc/psyche-helper

# --- dedicated account ------------------------------------------------------------------------
DED=psyche-h7-ded
refuse "dedicated: a name that is not ours is refused" sudo bash "$INST" --dedicated-user root
sudo bash "$INST" --dedicated-user $DED --ceiling narrow >"$W/ded.log" 2>&1 && ok "dedicated: installer" || { bad "dedicated: installer"; cat "$W/ded.log"; }
DED_UID="$(uid_of $DED 2>/dev/null || echo 0)"
check "dedicated: the account has no login shell and a Psyche marker" bash -c "getent passwd $DED | grep -q 'nologin' && getent passwd $DED | grep -q 'Psyche helper'"
check "dedicated: the policy is root-owned, 0644, narrow" bash -c "[ \"\$(stat -c %U:%a /etc/psyche-helper/policy.json)\" = root:644 ] && grep -q '\"enabled\": false' /etc/psyche-helper/policy.json"
check "dedicated: the account cannot write the policy" bash -c "! sudo -u $DED sh -c 'echo x >> /etc/psyche-helper/policy.json'"
check "dedicated: the program is root's, in root's folders, and the account has no copy" bash -c "[ \"\$(stat -c %U:%a /usr/local/lib/psyche-helper/psyche-helper)\" = root:755 ] && [ \"\$(stat -c %U:%a /usr/local/lib/psyche-helper)\" = root:755 ] && sudo test ! -e /home/$DED/.local/lib/psyche-helper"
check "dedicated: the service file is root's too (/etc/systemd/user) and verifies" bash -c "[ \"\$(stat -c %U:%a /etc/systemd/user/psyche-helper-remote.service)\" = root:644 ] && grep -q '^ExecStart=/usr/local/lib/psyche-helper/psyche-helper remote' /etc/systemd/user/psyche-helper-remote.service && systemd-analyze verify --user /etc/systemd/user/psyche-helper-remote.service /etc/systemd/user/psyche-machine.slice"
check "dedicated: the account cannot replace the program or the service file" bash -c "! sudo -u $DED sh -c 'echo x > /usr/local/lib/psyche-helper/psyche-helper' && ! sudo -u $DED sh -c 'echo x > /etc/systemd/user/psyche-helper-remote.service'"
ctl $DED start psyche-helper-remote.service
check "dedicated: the helper runs as the dedicated account" bash -c "wait_for 10 ctl $DED is-active --quiet psyche-helper-remote.service && [ \"\$(ps -o user= -p \$(ctl $DED show -p MainPID --value psyche-helper-remote.service))\" = $DED ]"
check "dedicated: a second run reuses the account and keeps the root-owned policy" bash -c "sudo bash $INST --dedicated-user $DED 2>&1 | grep -q 'kept as it is'"
check "dedicated: it does not take over an account it did not create" bash -c "sudo useradd -m psyche-h7-upd && ! sudo bash $INST --dedicated-user psyche-h7-upd"
sudo userdel -r psyche-h7-upd >/dev/null 2>&1
PIDD="$(ctl $DED show -p MainPID --value psyche-helper-remote.service)"
sudo systemctl stop "user@$DED_UID.service"; sudo systemctl start "user@$DED_UID.service"
check "reboot (simulated): the dedicated helper is back" bash -c "wait_for 20 ctl $DED is-active --quiet psyche-helper-remote.service && [ \"\$(ctl $DED show -p MainPID --value psyche-helper-remote.service)\" != $PIDD ]"
# Links the account plants in its own home must lead nowhere with root's rights: re-run the installer,
# --uninstall and --uninstall --purge as root and see that what the links point at is untouched.
V1=/var/tmp/psyche-h7-victim1; V2=/var/tmp/psyche-h7-victim2
sudo rm -rf $V1 $V2; sudo mkdir -p $V1/lib $V2; echo keep | sudo tee $V1/file $V2/file >/dev/null
sudo chmod 755 $V1 $V2 $V1/lib
snap() { sudo bash -c "stat -c '%n %U:%G %a' $V1 $V1/lib $V2 /etc /etc/psyche-helper /etc/psyche-helper/policy.json /etc/passwd; find $V1 $V2 /etc/psyche-helper | sort; cat $V1/file $V2/file; sha256sum /etc/psyche-helper/policy.json"; }
snap >"$W/snap0"
sudo -u $DED bash -c "cd /home/$DED && mkdir -p .local .config && mv .local .local.old && ln -s $V1 .local && mv .config .config.old && ln -s $V2 .config"
sudo bash "$INST" --dedicated-user $DED >"$W/ded-plant1.log" 2>&1
sudo bash "$INST" --dedicated-user $DED --uninstall >"$W/ded-plant2.log" 2>&1
snap >"$W/snap0b"
check "planted links (.local, .config): install and --uninstall as root leave their targets and /etc alone" cmp "$W/snap0" "$W/snap0b"
sudo -u $DED bash -c "cd /home/$DED && rm -f .local .config && mv .local.old .local && mv .config.old .config && mkdir -p .local && rm -rf .local/lib && ln -s /etc .local/lib && ln -sfn /etc/psyche-helper .config/psyche-helper"
snap >"$W/snap1"
sudo bash "$INST" --dedicated-user $DED >"$W/ded-plant3.log" 2>&1
sudo bash "$INST" --dedicated-user $DED --uninstall --purge >"$W/ded-plant4.log" 2>&1
snap >"$W/snap1b"
check "planted links (.local/lib -> /etc, .config/psyche-helper -> /etc/psyche-helper): install, --uninstall --purge leave /etc alone" cmp "$W/snap1" "$W/snap1b"
check "dedicated: --uninstall --purge removes the account and root's files" bash -c "! id $DED && [ ! -e /usr/local/lib/psyche-helper ] && [ ! -e /etc/systemd/user/psyche-helper-remote.service ]"
sudo rm -rf $V1 $V2
sudo rm -rf /etc/psyche-helper

# --- update (real binaries) -------------------------------------------------------------------
UPD=psyche-h7-upd
sudo useradd -m -s /bin/bash $UPD; sudo loginctl enable-linger $UPD
UPD_UID="$(uid_of $UPD)"; UH="/home/$UPD"
wait_for 20 sock "$UPD_UID"
mkdir -p "$W/upd" && tar --zstd -xf "$W/pk-real1/$TAR" -C "$W/upd" && chmod -R a+rX "$W/upd"
as $UPD bash "$W/upd/psyche-helper-0.1.0-linux-$ARCH/install.sh" >"$W/upd-install.log" 2>&1 && ok "update: install 0.1.0 (real binary)" || { bad "update: install"; cat "$W/upd-install.log"; }
HB="$UH/.local/lib/psyche-helper/psyche-helper"
sudo "$HB" update --check >"$W/u-root.log" 2>&1; RR=$?
check "update refuses to run as root, and says why" bash -c "[ $RR -ne 0 ] && grep -q 'do not run update as root' $W/u-root.log"
check "--build-info lists the update key ids (the release job compares them with release-keys.ts)" bash -c "as $UPD $HB --build-info | grep -q '\"updateKeys\":\\[.*37312dba0e2eddad'"
ver() { as $UPD "$HB" --build-info | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }
[ "$(ver)" = 0.1.0 ] && ok "update: the installed helper reports 0.1.0" || bad "update: installed version is $(ver)"

mkfeed() { # mkfeed DIR PACKAGEDIR VERSION KEYFILE
  rm -rf "$1"; mkdir -p "$1"; cp "$2"/psyche-helper-"$3"-linux-"$ARCH".* "$1/"
  "$NODE" "$REPO/deploy/scripts/update-manifest.mjs" build --release "$3" --base "https://github.com/devmello/psyche/releases/download/v$3/" --linux-only --helper-complete "$1"/psyche-helper-"$3"-linux-"$ARCH".* >"$1/update-manifest.json"
  PSYCHE_RELEASE_SIGNING_KEY="$(cat "$4")" "$NODE" "$REPO/deploy/scripts/update-manifest.mjs" sign "$1/update-manifest.json"
  chmod -R a+rX "$1"
}
mkfeed "$W/feed2" "$W/pk-real2" 0.2.0 "$KEY"
HELPER="as $UPD $HB"
$HELPER update --check --from "$W/feed2" >"$W/u-check.log" 2>&1
check "update --check: says 0.2.0 is available and installs nothing" bash -c "grep -q '0.2.0 is available' $W/u-check.log && [ \"$(ver)\" = 0.1.0 ]"

# tampered artifacts and manifests are refused, and nothing changes
cp -r "$W/feed2" "$W/feed-t1"; python3 - "$W/feed-t1/psyche-helper-0.2.0-linux-$ARCH.tar.zst" <<'PY'
import sys
p=sys.argv[1]; b=bytearray(open(p,'rb').read()); b[len(b)//2]^=0xff; open(p,'wb').write(b)
PY
$HELPER update --from "$W/feed-t1" >"$W/u-t1.log" 2>&1; R1=$?
check "tampered tarball: refused (SHA-256), installed helper unchanged" bash -c "[ $R1 -ne 0 ] && grep -q 'SHA-256' $W/u-t1.log && [ \"$(ver)\" = 0.1.0 ]"
cp -r "$W/feed2" "$W/feed-t2"; sed -i 's/"release": "0.2.0"/"release": "0.2.1"/' "$W/feed-t2/update-manifest.json"
$HELPER update --from "$W/feed-t2" >"$W/u-t2.log" 2>&1; R2=$?
check "tampered manifest: refused (signature)" bash -c "[ $R2 -ne 0 ] && grep -q 'signature does not match' $W/u-t2.log && [ \"$(ver)\" = 0.1.0 ]"
cp -r "$W/feed2" "$W/feed-t3"; rm "$W/feed-t3/update-manifest.json.sig"
$HELPER update --from "$W/feed-t3" >"$W/u-t3.log" 2>&1; R3=$?
check "unsigned manifest: refused" bash -c "[ $R3 -ne 0 ] && grep -q 'no signature' $W/u-t3.log"
mkfeed "$W/feed-t4" "$W/pk-real2" 0.2.0 "$OTHER_KEY"
$HELPER update --from "$W/feed-t4" >"$W/u-t4.log" 2>&1; R4=$?
check "manifest signed by a key the helper does not trust: refused" bash -c "[ $R4 -ne 0 ] && grep -q 'does not trust' $W/u-t4.log"
# A manifest whose artifacts are not under the pinned host (signed by the right key).
cp -r "$W/feed2" "$W/feed-t5"; sed -i 's#github.com/devmello/psyche/releases/download/v0.2.0/#evil.example/psyche/#' "$W/feed-t5/update-manifest.json"
PSYCHE_RELEASE_SIGNING_KEY="$(cat "$KEY")" "$NODE" "$REPO/deploy/scripts/update-manifest.mjs" sign "$W/feed-t5/update-manifest.json"
$HELPER update --from "$W/feed-t5" >"$W/u-t5.log" 2>&1; R5=$?
check "signed manifest pointing off the pinned host: refused" bash -c "[ $R5 -ne 0 ] && grep -q 'not under https://github.com/devmello/psyche' $W/u-t5.log"

# a real update with a service that stays up (the unit is held up by a drop-in; see header of the unit)
as $UPD mkdir -p "$UH/.config/systemd/user/psyche-helper-remote.service.d"
as $UPD tee "$UH/.config/systemd/user/psyche-helper-remote.service.d/test.conf" >/dev/null <<EOF
[Service]
ExecStart=
ExecStart=/bin/sh -c 'if $HB --build-info | grep -q 0.3.0; then exit 1; fi; exec sleep infinity'
EOF
ctl $UPD daemon-reload; ctl $UPD start psyche-helper-remote.service
wait_for 10 ctl $UPD is-active --quiet psyche-helper-remote.service || bad "update: the test service did not start"
PIDU="$(ctl $UPD show -p MainPID --value psyche-helper-remote.service)"
$HELPER update --from "$W/feed2" >"$W/u-ok.log" 2>&1 && ok "update: 0.1.0 -> 0.2.0 (signed, hashed, pinned)" || { bad "update: apply"; cat "$W/u-ok.log"; }
[ "$(ver)" = 0.2.0 ] && ok "update: the installed helper now reports 0.2.0" || bad "update: version is $(ver)"
check "update: the service was restarted and is up" bash -c "ctl $UPD is-active --quiet psyche-helper-remote.service && [ \"\$(ctl $UPD show -p MainPID --value psyche-helper-remote.service)\" != $PIDU ]"
check "update: the previous helper is kept next to it" sudo test -x "$UH/.local/lib/psyche-helper/psyche-helper.prev"
$HELPER update --from "$W/feed2" >"$W/u-again.log" 2>&1
check "update: running it again is a no-op" grep -q "newest release" "$W/u-again.log"
mkfeed "$W/feed1" "$W/pk-real1" 0.1.0 "$KEY"
$HELPER update --from "$W/feed1" >"$W/u-down.log" 2>&1
check "downgrade: an older signed release is not installed" bash -c "grep -q 'newest release' $W/u-down.log && [ \"$(ver)\" = 0.2.0 ]"
$HELPER update --rollback >"$W/u-rb.log" 2>&1 && ok "rollback: update --rollback" || { bad "rollback"; cat "$W/u-rb.log"; }
[ "$(ver)" = 0.1.0 ] && ok "rollback: the installed helper reports 0.1.0 again" || bad "rollback: version is $(ver)"
check "rollback: the service is still up" bash -c "wait_for 10 ctl $UPD is-active --quiet psyche-helper-remote.service"

# an update whose service will not start rolls itself back (0.3.0's stand-in makes the drop-in's unit exit 1)
mkfeed "$W/feed3" "$W/pk-stub3" 0.3.0 "$KEY"
$HELPER update --from "$W/feed3" >"$W/u-bad.log" 2>&1; RB=$?
check "failed start: the update rolls itself back and says so" bash -c "[ $RB -ne 0 ] && grep -q 'previous helper is back' $W/u-bad.log && [ \"$(ver)\" = 0.1.0 ]"
check "failed start: the service is running the old helper" bash -c "wait_for 15 ctl $UPD is-active --quiet psyche-helper-remote.service"

echo
echo "helper-only package checks: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
