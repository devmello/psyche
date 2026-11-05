#!/bin/bash
# Signs an already packaged Psyche.app with Psyche's self-signed release certificate, inside out, with
# the hardened runtime. The ONE place that does it: build-local.sh and the release workflow's `sign`
# job both call this script, so local and CI signing cannot drift
# (docs/design/updates-and-install-2026.md §2.3, §2.9).
#
#   deploy/macos/sign-bundle.sh --app <Psyche.app> --identity <sha1|"Psyche Release">
#                               [--keychain <file>] [--timestamp] [--requirements <file>]
#
#   --app           the packaged app (unsigned or ad-hoc signed: it is re-signed with --force)
#   --identity      the certificate's SHA-1 (40 hex digits) or the exact name "Psyche Release".
#                   A Developer ID is signed (and notarized) by electron-forge instead; this refuses it.
#   --keychain      the keychain file that holds the identity (default: the search list)
#   --timestamp     ask Apple's timestamp server for a secure timestamp (needs the network)
#   --requirements  designated-requirements.txt (default: deploy/macos/designated-requirements.txt); the
#                   `desktop` line is passed to codesign for Psyche.app. A placeholder there is skipped.
#
# What it does, in order, with the same entitlements apps/desktop/src/packaging/signing-config.ts uses:
#   1. every Mach-O under Resources/psyched (Node runtime, addons, libraries)  entitlements.self-signed.psyched.plist
#   2. every other Mach-O in the bundle except PsycheHelper.app (Electron frameworks and libraries,
#      node-pty in app.asar.unpacked), deepest first                           entitlements.self-signed.plist
#   3. every framework and helper .app under Contents/Frameworks, deepest first  entitlements.self-signed.plist
#   4. Resources/PsycheHelper.app, identifier com.psyche.helper, with its own entitlements
#                                                  (apps/mac-helper/Support/PsycheHelper.entitlements; no library-validation key)
#   5. Psyche.app itself, with the pinned designated requirement
# then `codesign --verify --deep --strict`. It runs only codesign, find, file and sort: no package
# manager, no build tool and no third-party code, so it is safe to run while a signing keychain is unlocked.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
APP=""
ID=""
KEYCHAIN=""
TS="--timestamp=none"
REQS="$HERE/designated-requirements.txt"
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="${2:?--app needs a path}"; shift 2 ;;
    --identity) ID="${2:?--identity needs a hash or name}"; shift 2 ;;
    --keychain) KEYCHAIN="${2:?--keychain needs a file}"; shift 2 ;;
    --timestamp) TS="--timestamp"; shift ;;
    --requirements) REQS="${2:?--requirements needs a file}"; shift 2 ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done
[ -d "$APP/Contents" ] || { echo "no such app: $APP" >&2; exit 64; }
[ -n "$ID" ] || { echo "--identity is required" >&2; exit 64; }
case "$ID" in
  *[!0-9a-fA-F]*) [ "$ID" = "Psyche Release" ] || { echo "identity must be the certificate's SHA-1 or exactly \"Psyche Release\" (a Developer ID is signed by electron-forge)" >&2; exit 64; } ;;
  *) [ "${#ID}" -eq 40 ] || { echo "a hash identity must be 40 hex digits" >&2; exit 64; } ;;
esac
CODESIGN="${CODESIGN:-/usr/bin/codesign}"
APP="$(cd "$APP" && pwd -P)"

APP_ENT="$ROOT/apps/desktop/entitlements.self-signed.plist"
GW_ENT="$ROOT/apps/desktop/entitlements.self-signed.psyched.plist"
HELPER_ENT="$ROOT/apps/mac-helper/Support/PsycheHelper.entitlements"
for f in "$APP_ENT" "$GW_ENT" "$HELPER_ENT"; do [ -r "$f" ] || { echo "missing $f" >&2; exit 1; }; done

REQ=""
if [ -r "$REQS" ]; then
  REQ="$(awk -F'\t' '$1=="desktop"{print $2; exit}' "$REQS")"
  case "$REQ" in *SHA1_OF_PSYCHE_RELEASE_CERT*) REQ="" ;; esac
fi

# A hash identity is the release certificate only if it is the SHA-1 pinned in the requirements file
# (while that file still has its placeholder nothing is pinned and any hash is accepted).
pinned_hash="$(printf '%s' "$REQ" | sed -n 's/.*certificate leaf = H"\([0-9a-fA-F]\{40\}\)".*/\1/p')"
if [ "$ID" != "Psyche Release" ] && [ -n "$pinned_hash" ]; then
  if [ "$(printf '%s' "$ID" | tr 'A-F' 'a-f')" != "$(printf '%s' "$pinned_hash" | tr 'A-F' 'a-f')" ]; then
    echo "identity $ID is not the SHA-1 pinned in $REQS ($pinned_hash): refusing to sign with another certificate" >&2
    exit 64
  fi
fi

sign() { # sign <path> <entitlements|""> [extra codesign args...]
  local path="$1" ent="$2"; shift 2
  local args=(--force --options runtime "$TS")
  [ -n "$KEYCHAIN" ] && args+=(--keychain "$KEYCHAIN")
  [ -n "$ent" ] && args+=(--entitlements "$ent")
  "$CODESIGN" "${args[@]}" "$@" --sign "$ID" "$path"
}

HELPER="$APP/Contents/Resources/PsycheHelper.app"
GATEWAY="$APP/Contents/Resources/psyched"

# Paths are collected NUL-separated (a name with a newline or a space is just a name) and only paths
# under "$APP"/ are ever signed. `find` does not follow symlinks, so nothing outside the bundle is reached.
FOUND=()
collect_macho() { # collect_macho <dir>: Mach-O files (executables, .node addons, dylibs)
  local f
  FOUND=()
  while IFS= read -r -d '' f; do
    case "$f" in "$APP"/*) ;; *) continue ;; esac
    case "$(file -b "$f" 2>/dev/null)" in *Mach-O*) FOUND+=("$f") ;; esac
  done < <(find "$1" -type f \( -perm -u+x -o -name '*.node' -o -name '*.dylib' -o -name '*.so' \) -print0 2>/dev/null)
}
collect_bundles() { # collect_bundles <dir>: .framework and .app directories
  local f
  FOUND=()
  while IFS= read -r -d '' f; do
    case "$f" in "$APP"/*) FOUND+=("$f") ;; esac
  done < <(find "$1" -type d \( -name '*.framework' -o -name '*.app' \) -print0 2>/dev/null)
}
each_deepest() { # each_deepest <callback>: calls it on every path in FOUND, deepest first
  local cb="$1" max=0 d f slashes
  for f in ${FOUND[@]+"${FOUND[@]}"}; do
    slashes="${f//[!\/]/}"
    if [ "${#slashes}" -gt "$max" ]; then max="${#slashes}"; fi
  done
  d="$max"
  while [ "$d" -ge 0 ]; do
    for f in ${FOUND[@]+"${FOUND[@]}"}; do
      slashes="${f//[!\/]/}"
      if [ "${#slashes}" -eq "$d" ]; then "$cb" "$f"; fi
    done
    d=$((d - 1))
  done
}
sign_gateway_file() { sign "$1" "$GW_ENT"; }
sign_app_file() {
  case "$1" in "$HELPER"/*|"$GATEWAY"/*) return 0 ;; esac
  sign "$1" "$APP_ENT"
}
sign_bundle_dir() {
  case "$1" in
    *.framework) sign "$1" "" ;;
    *) sign "$1" "$APP_ENT" ;;
  esac
}

echo "==> signing Gateway binaries"
if [ -d "$GATEWAY" ]; then
  collect_macho "$GATEWAY"
  each_deepest sign_gateway_file
fi

echo "==> signing the rest of the bundle, inside out"
collect_macho "$APP/Contents"
each_deepest sign_app_file

# Frameworks and helper apps, deepest first.
collect_bundles "$APP/Contents/Frameworks"
each_deepest sign_bundle_dir

if [ -d "$HELPER" ]; then
  echo "==> signing PsycheHelper.app (its own entitlements, full library validation)"
  sign "$HELPER" "$HELPER_ENT" --identifier com.psyche.helper
fi

echo "==> signing Psyche.app"
if [ -n "$REQ" ]; then
  sign "$APP" "$APP_ENT" "-r=designated => $REQ"
else
  echo "note: no pinned requirement (placeholder or no file); codesign's default requirement is used" >&2
  sign "$APP" "$APP_ENT"
fi

"$CODESIGN" --verify --deep --strict "$APP"
echo "==> signed and verified: $APP"
