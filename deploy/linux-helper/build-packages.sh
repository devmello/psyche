#!/usr/bin/env bash
# Builds the helper-only packages from one built binary (linux-helper-only design 3.1; H7):
#
#   build-packages.sh --version 1.2.3 --arch x64|arm64 --binary path/to/psyche-helper --out DIR
#
# writes, into DIR, with the names deploy/scripts/update-manifest.mjs classifies:
#   psyche-helper-<version>-linux-<arch>.tar.zst   the tarball (install.sh, and `psyche-helper update`)
#   psyche-helper-<version>-linux-<arch>.deb
#   psyche-helper-<version>-linux-<arch>.rpm
# Needs GNU tar, zstd and dpkg-deb; rpmbuild for the rpm (--no-rpm skips it).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
VERSION="" ARCH="" BINARY="" OUT="" RPM=1
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift ;;
    --arch) ARCH="$2"; shift ;;
    --binary) BINARY="$2"; shift ;;
    --out) OUT="$2"; shift ;;
    --no-rpm) RPM=0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "--version must look like 1.2.3" >&2; exit 2; }
case "$ARCH" in x64) DEB_ARCH=amd64 RPM_ARCH=x86_64 ;; arm64) DEB_ARCH=arm64 RPM_ARCH=aarch64 ;; *) echo "--arch must be x64 or arm64" >&2; exit 2 ;; esac
[ -x "$BINARY" ] || { echo "--binary is not an executable file" >&2; exit 2; }
[ -n "$OUT" ] || { echo "--out is required" >&2; exit 2; }
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Same bytes for the same inputs: a fixed time, root ownership, sorted names.
EPOCH="${SOURCE_DATE_EPOCH:-1767225600}" # 2026-01-01: rpm rejects a 1970 changelog date
export SOURCE_DATE_EPOCH="$EPOCH"
TAR=(tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner --format=gnu)

# --- the tarball ------------------------------------------------------------------------------
ROOT="psyche-helper-$VERSION-linux-$ARCH"
mkdir -p "$WORK/t/$ROOT/bin" "$WORK/t/$ROOT/share"
install -m 0755 "$BINARY" "$WORK/t/$ROOT/bin/psyche-helper"
install -m 0755 "$HERE/install.sh" "$WORK/t/$ROOT/install.sh"
for f in psyche-helper-remote.service psyche-machine.slice policy.default.json policy.narrow.json; do
  install -m 0644 "$HERE/$f" "$WORK/t/$ROOT/share/$f"
done
printf '%s\n' "$VERSION" >"$WORK/t/$ROOT/VERSION"
"${TAR[@]}" -C "$WORK/t" -cf - "$ROOT" | zstd -q -19 -T1 -o "$OUT/$ROOT.tar.zst" -f

# --- the deb ----------------------------------------------------------------------------------
D="$WORK/deb"
install -d "$D/DEBIAN" "$D/usr/lib/psyche-helper" "$D/usr/bin" "$D/usr/lib/systemd/user" "$D/etc/psyche-helper"
install -m 0755 "$BINARY" "$D/usr/lib/psyche-helper/psyche-helper"
install -m 0755 "$HERE/install.sh" "$D/usr/lib/psyche-helper/install.sh"
install -m 0644 "$HERE/policy.default.json" "$D/usr/lib/psyche-helper/policy.default.json"
install -m 0644 "$HERE/policy.narrow.json" "$D/usr/lib/psyche-helper/policy.narrow.json"
ln -s ../lib/psyche-helper/psyche-helper "$D/usr/bin/psyche-helper"
ln -s ../lib/psyche-helper/install.sh "$D/usr/bin/psyche-helper-setup"
install -m 0644 "$HERE/psyche-helper-remote.service" "$HERE/psyche-machine.slice" "$D/usr/lib/systemd/user/"
install -m 0644 "$HERE/policy.default.json" "$D/etc/psyche-helper/policy.json"
echo /etc/psyche-helper/policy.json >"$D/DEBIAN/conffiles"
SIZE_KB="$(du -sk "$D" | cut -f1)"
cat >"$D/DEBIAN/control" <<EOF
Package: psyche-helper
Version: $VERSION
Architecture: $DEB_ARCH
Maintainer: Psyche <noreply@psyche.invalid>
Section: utils
Priority: optional
Installed-Size: $SIZE_KB
Depends: systemd, xvfb, dbus-user-session, at-spi2-core, xauth, bubblewrap
Homepage: https://github.com/devmello/psyche
Description: lets your Mac's Psyche use this computer
 The Psyche helper dials the Gateway on your Mac and does what you approve there: runs a
 private screen for apps, and (within /etc/psyche-helper/policy.json) commands and files.
 After installing, run psyche-helper-setup as the account the helper should use.
EOF
install -m 0755 "$HERE/packaging/deb/postinst" "$D/DEBIAN/postinst"
dpkg-deb --root-owner-group -Zxz --build "$D" "$OUT/$ROOT.deb" >/dev/null

# --- the rpm ----------------------------------------------------------------------------------
if [ "$RPM" = 1 ]; then
  command -v rpmbuild >/dev/null || { echo "rpmbuild not found (--no-rpm skips the rpm)" >&2; exit 1; }
  R="$WORK/rpm"
  mkdir -p "$R/SOURCES" "$R/SPECS" "$R/BUILD" "$R/RPMS" "$R/SRPMS" "$R/BUILDROOT"
  install -m 0755 "$BINARY" "$R/SOURCES/psyche-helper"
  install -m 0755 "$HERE/install.sh" "$R/SOURCES/install.sh"
  for f in psyche-helper-remote.service psyche-machine.slice policy.default.json policy.narrow.json; do
    install -m 0644 "$HERE/$f" "$R/SOURCES/$f"
  done
  # rpm versions take no '-': a pre-release becomes Version~pre.
  RPM_VERSION="${VERSION/-/~}"
  sed -e "s/@VERSION@/$RPM_VERSION/" -e "s/@DATE@/$(LC_ALL=C date -u -d "@$EPOCH" '+%a %b %d %Y')/" \
    "$HERE/packaging/rpm/psyche-helper.spec.in" >"$R/SPECS/psyche-helper.spec"
  rpmbuild -bb --quiet --target "$RPM_ARCH-linux" \
    --define "_topdir $R" --define "_sourcedir $R/SOURCES" --define "_rpmdir $R/RPMS" \
    --define "source_date_epoch_from_changelog 0" --define "use_source_date_epoch_as_buildtime 1" \
    --define "_buildhost reproducible" --define "clamp_mtime_to_source_date_epoch 1" \
    "$R/SPECS/psyche-helper.spec"
  cp "$R"/RPMS/*/psyche-helper-*.rpm "$OUT/$ROOT.rpm"
fi
ls -l "$OUT"/psyche-helper-"$VERSION"-linux-"$ARCH".*
