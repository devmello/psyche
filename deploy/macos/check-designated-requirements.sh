#!/bin/bash
# Fails when a built Psyche.app (or the PsycheHelper.app inside it) does not carry the designated
# requirement pinned in deploy/macos/designated-requirements.txt (docs/design/updates-and-install-2026.md §2.9).
# TCC privacy grants and Squirrel.Mac's "is the new app the same app?" check both depend on it.
#
#   deploy/macos/check-designated-requirements.sh [--file <requirements.txt>] <Psyche.app>
#
# Checks, in order:
#   1. every line of the file is satisfied: `codesign -d -r-` prints exactly that requirement, and
#      `codesign --verify --strict -R "=<requirement>"` agrees.
#   2. every Mach-O the Gateway carries (psyched's Node runtime, each .node addon, each .dylib) is
#      signed with the same certificate as the app (same `certificate leaf = H"..."`), so no addon
#      was left ad-hoc or signed by another key.
#   3. Info.plist has no LSFileQuarantineEnabled. With it set, macOS would put the quarantine flag on
#      every file the app writes, including the updates it downloads (the "Apple could not verify"
#      dialog on every update). Electron does not set it; this guards against it being added.
#
# Exit codes: 0 all good, 1 a check failed, 2 usage, 3 the requirements file still has its
# placeholder instead of the certificate's SHA-1 (run deploy/macos/make-signing-cert.sh).
# CODESIGN and PLISTBUDDY can point at other tools (the tests use fakes).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
FILE="$HERE/designated-requirements.txt"
APP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --file) FILE="${2:?--file needs a path}"; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    -*) echo "unknown argument: $1" >&2; exit 2 ;;
    *) APP="$1"; shift ;;
  esac
done
[ -n "$APP" ] || { echo "usage: check-designated-requirements.sh [--file <requirements.txt>] <Psyche.app>" >&2; exit 2; }
[ -d "$APP" ] || { echo "no such app: $APP" >&2; exit 2; }
[ -r "$FILE" ] || { echo "cannot read $FILE" >&2; exit 2; }
CODESIGN="${CODESIGN:-/usr/bin/codesign}"
PLISTBUDDY="${PLISTBUDDY:-/usr/libexec/PlistBuddy}"

if grep -v '^#' "$FILE" | grep -q 'SHA1_OF_PSYCHE_RELEASE_CERT'; then
  echo "$FILE still has the SHA1_OF_PSYCHE_RELEASE_CERT placeholder." >&2
  echo "Run deploy/macos/make-signing-cert.sh once, put the SHA-1 it prints in that file, and commit it." >&2
  exit 3
fi

path_for() {
  case "$1" in
    desktop) printf '%s' "$APP" ;;
    helper) printf '%s' "$APP/Contents/Resources/PsycheHelper.app" ;;
    *) return 1 ;;
  esac
}

fail=0
desktop_req=""
count=0
while IFS=$'\t' read -r name req; do
  case "$name" in ""|\#*) continue ;; esac
  [ -n "$req" ] || { echo "bad line in $FILE: $name" >&2; exit 2; }
  target="$(path_for "$name")" || { echo "unknown name in $FILE: $name" >&2; exit 2; }
  [ -d "$target" ] || { echo "FAIL $name: $target does not exist" >&2; fail=1; continue; }
  count=$((count + 1))
  [ "$name" = desktop ] && desktop_req="$req"
  actual="$("$CODESIGN" -d -r- "$target" 2>/dev/null | sed -n 's/^designated => //p')"
  if [ "$actual" != "$req" ]; then
    echo "FAIL $name: designated requirement differs" >&2
    echo "  expected: $req" >&2
    echo "  actual:   ${actual:-<none: unsigned or ad-hoc>}" >&2
    fail=1
    continue
  fi
  if ! "$CODESIGN" --verify --strict -R "=$req" "$target" 2>/dev/null; then
    echo "FAIL $name: the signature does not satisfy its requirement" >&2
    fail=1
    continue
  fi
  echo "ok   $name: $req"
done < "$FILE"
[ "$count" -gt 0 ] || { echo "no requirements in $FILE" >&2; exit 2; }

# 2. Everything the Gateway carries is signed by the same certificate as the app.
leaf="$(printf '%s' "$desktop_req" | sed -n 's/.*certificate leaf = \(H"[0-9a-fA-F]*"\).*/\1/p')"
if [ -n "$leaf" ] && [ -d "$APP/Contents/Resources/psyched" ]; then
  checked=0
  bad=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    checked=$((checked + 1))
    if ! "$CODESIGN" -d -r- "$f" 2>/dev/null | grep -qF "certificate leaf = $leaf"; then
      echo "FAIL ${f#"$APP"/}: not signed with the release certificate" >&2
      fail=1
      bad=$((bad + 1))
    fi
  done < <(find "$APP/Contents/Resources/psyched" -type f \( -name '*.node' -o -name '*.dylib' -o -path '*/runtime/node' \))
  if [ "$bad" -eq 0 ]; then
    echo "ok   $checked Gateway binaries (Node runtime, addons, libraries) carry the same certificate"
  fi
fi

# 3. No quarantine flag on files the app writes.
if "$PLISTBUDDY" -c 'Print :LSFileQuarantineEnabled' "$APP/Contents/Info.plist" >/dev/null 2>&1; then
  echo "FAIL Info.plist sets LSFileQuarantineEnabled: downloaded updates would be quarantined" >&2
  fail=1
else
  echo "ok   Info.plist has no LSFileQuarantineEnabled"
fi

exit "$fail"
