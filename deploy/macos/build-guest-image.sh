#!/bin/sh
# Builds a reusable, checksummed Psyche guest image (feature L7; spike 06 recipe steps 1–9).
# Owner: S14. macOS 27 host for a macOS 27 guest (unattended provisioning). Boots one guest.
#
#   deploy/macos/build-guest-image.sh (--ipsw <path> | --download) [--out <dir>] [--id <id>]
#                                     [--helper <PsycheHelper.app>] [--archive] [--keep] [--force]
#
# Steps, all inside a throwaway PSYCHE_HOME (your own sandbox Mac is untouched):
#   1. create the guest from the IPSW (or Apple's latest with --download, ~26 GB) and install macOS
#   2. first boot with VZMacGuestProvisioningOptions: admin user, auto-login, Remote Login
#   3. install Psyche in the guest over SSH from a `git archive` of this checkout + the helper app
#   4. stop, then pre-grant Accessibility / Screen Recording to the guest helper offline (TCC.db)
#   5. export <out>/<id>/: Disk, AuxiliaryStorage, HardwareModel, bootstrap.json, manifest.json
#      (SHA-256 of every file). Never the MachineIdentifier: each import gets its own.
# --archive also writes <id>.aar (Apple Archive) and <id>.aar.sha256; <id>.manifest.sha256 is the
# value to publish with the image (`vm.create {image, imageSha256}` checks it).
#
# The image contains the guest's bootstrap password (bootstrap.json). Importing rotates it at the
# first start, but anyone holding the image can read it: share images only with people you trust.
# Needs ~60 GB free and ≥ 24 GB RAM (--force to override); takes 20–40 min plus any download.
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/apps/mac-helper/dist/guest-images"
HELPER_APP="$ROOT/apps/mac-helper/dist/PsycheHelper.app"
IPSW=""; DOWNLOAD=0; ID=""; ARCHIVE=0; KEEP=0; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ipsw) IPSW="${2:?--ipsw needs a path}"; shift 2 ;;
    --download) DOWNLOAD=1; shift ;;
    --out) OUT="${2:?--out needs a directory}"; shift 2 ;;
    --id) ID="${2:?--id needs a value}"; shift 2 ;;
    --helper) HELPER_APP="${2:?--helper needs a path}"; shift 2 ;;
    --archive) ARCHIVE=1; shift ;;
    --keep) KEEP=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done
[ -n "$IPSW" ] || [ "$DOWNLOAD" = 1 ] || { echo "pass --ipsw <path> or --download" >&2; exit 64; }
command -v aa >/dev/null || { echo "build-guest-image.sh needs macOS (aa, codesign)" >&2; exit 2; }

MEM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
if [ "$MEM_GB" -lt 24 ] && [ "$FORCE" = 0 ]; then
  echo "this Mac has ${MEM_GB} GB of memory; building an image boots an 8 GB guest. Use a bigger host or --force." >&2
  exit 2
fi

if [ ! -x "$HELPER_APP/Contents/MacOS/psyche-helper" ]; then
  "$ROOT/deploy/macos/build-helper.sh" >/dev/null
fi
codesign -d --entitlements - --xml "$HELPER_APP" 2>/dev/null | grep -q com.apple.security.virtualization \
  || { echo "$HELPER_APP lacks com.apple.security.virtualization" >&2; exit 1; }

WORK="$(mktemp -d -t psyche-guest-image)"
cleanup() { [ "$KEEP" = 1 ] && echo "kept build files in $WORK" >&2 || rm -rf "$WORK"; }
trap cleanup EXIT INT TERM
mkdir -p "$WORK/home" "$WORK/payload" "$OUT"
chmod 700 "$WORK/home"

# The payload the guest installs from (read-only share): this checkout's tracked files and the helper.
git -C "$ROOT" archive --format=tar HEAD | tar -x -C "$WORK/payload"
ditto "$HELPER_APP" "$WORK/payload/Psyche Helper.app"

set -- --payload "$WORK/payload" --out "$OUT"
[ -n "$IPSW" ] && set -- "$@" --ipsw "$IPSW"
[ "$DOWNLOAD" = 1 ] && set -- "$@" --download
[ -n "$ID" ] && set -- "$@" --id "$ID"
PSYCHE_HOME="$WORK/home" PSYCHE_NODE_SOCKET="$WORK/home/run/none.sock" \
  "$HELPER_APP/Contents/MacOS/psyche-helper" guest-image build "$@" > "$WORK/result.json"

IMAGE="$(plutil -extract path raw -o - "$WORK/result.json")"
MANIFEST_SHA="$(plutil -extract manifestSha256 raw -o - "$WORK/result.json")"
NAME="$(basename "$IMAGE")"
printf '%s  manifest.json\n' "$MANIFEST_SHA" > "$OUT/$NAME.manifest.sha256"
"$HELPER_APP/Contents/MacOS/psyche-helper" guest-image verify "$IMAGE" --sha256 "$MANIFEST_SHA" >/dev/null

if [ "$ARCHIVE" = 1 ]; then
  rm -f "$OUT/$NAME.aar"
  aa archive -d "$IMAGE" -o "$OUT/$NAME.aar"
  (cd "$OUT" && shasum -a 256 "$NAME.aar" > "$NAME.aar.sha256")
fi
echo "image:    $IMAGE"
echo "manifest: sha256 $MANIFEST_SHA (publish this with the image)"
[ "$ARCHIVE" = 1 ] && echo "archive:  $OUT/$NAME.aar"
exit 0
