#!/bin/bash
# Fails when a built Psyche.app (or the PsycheHelper.app inside it) does not carry the designated
# requirement pinned in deploy/macos/designated-requirements.txt (docs/design/updates-and-install-2026.md §2.9),
# or is signed more loosely than the release design allows.
# TCC privacy grants and Squirrel.Mac's "is the new app the same app?" check both depend on it.
#
#   deploy/macos/check-designated-requirements.sh [--file <requirements.txt>] <Psyche.app>
#
# Checks, in order:
#   1. BOTH names in the file (desktop and helper) are present, and each is satisfied: `codesign -d -r-`
#      prints exactly that requirement, and `codesign --verify --strict -R "=<requirement>"` agrees.
#   2. every Mach-O the Gateway carries (psyched's Node runtime, each .node addon, each .dylib) is
#      signed with the same certificate as the app (same `certificate leaf = H"..."`), so no addon
#      was left ad-hoc or signed by another key.
#   3. Info.plist has no LSFileQuarantineEnabled. With it set, macOS would put the quarantine flag on
#      every file the app writes, including the updates it downloads (the "Apple could not verify"
#      dialog on every update). Electron does not set it; this guards against it being added.
#   4. the hardened runtime is on for the app, every Electron helper, the helper app and psyched's
#      Node runtime; none of them has allow-dyld-environment-variables or get-task-allow; and
#      PsycheHelper.app does NOT have disable-library-validation (only the app, Electron's helpers and
#      psyched's Node need it, entitlements.self-signed*.plist).
#
# Exit codes: 0 all good, 1 a check failed, 2 usage or a malformed requirements file, 3 the
# requirements file still has its placeholder instead of the certificate's SHA-1 (run
# deploy/macos/make-signing-cert.sh). CODESIGN and PLISTBUDDY can point at other tools (tests use fakes).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
FILE="$HERE/designated-requirements.txt"
APP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --file) FILE="${2:?--file needs a path}"; shift 2 ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
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
seen=" "
# `|| [ -n "$name" ]` handles a last line with no trailing newline.
while IFS=$'\t' read -r name req || [ -n "$name" ]; do
  case "$name" in ""|\#*) continue ;; esac
  [ -n "$req" ] || { echo "bad line in $FILE: $name" >&2; exit 2; }
  target="$(path_for "$name")" || { echo "unknown name in $FILE: $name" >&2; exit 2; }
  case "$seen" in *" $name "*) echo "duplicate $name in $FILE" >&2; exit 2 ;; esac
  seen="$seen$name "
  [ -d "$target" ] || { echo "FAIL $name: $target does not exist" >&2; fail=1; continue; }
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
for need in desktop helper; do
  case "$seen" in *" $need "*) ;; *) echo "FAIL $FILE has no \"$need\" line: both desktop and helper must be pinned" >&2; fail=1 ;; esac
done

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

# 4. Hardened runtime and entitlements.
runtime_targets=("$APP")
while IFS= read -r f; do [ -n "$f" ] && runtime_targets+=("$f"); done < <(find "$APP/Contents/Frameworks" -maxdepth 1 -name '*.app' 2>/dev/null)
helper="$APP/Contents/Resources/PsycheHelper.app"
[ -d "$helper" ] && runtime_targets+=("$helper")
node_rt="$APP/Contents/Resources/psyched/runtime/node"
[ -f "$node_rt" ] && runtime_targets+=("$node_rt")
loose=0
for t in "${runtime_targets[@]}"; do
  label="${t#"$APP"}"; label="${label:-Psyche.app}"
  if ! "$CODESIGN" -dv "$t" 2>&1 | grep -q 'flags=.*runtime'; then
    echo "FAIL $label: the hardened runtime is not on" >&2
    fail=1; loose=1
  fi
  ents="$("$CODESIGN" -d --entitlements :- "$t" 2>/dev/null || true)"
  for key in com.apple.security.cs.allow-dyld-environment-variables com.apple.security.get-task-allow; do
    if printf '%s' "$ents" | grep -qF "$key"; then
      echo "FAIL $label: has the entitlement $key" >&2
      fail=1; loose=1
    fi
  done
done
if [ -d "$helper" ] && "$CODESIGN" -d --entitlements :- "$helper" 2>/dev/null | grep -qF com.apple.security.cs.disable-library-validation; then
  echo "FAIL PsycheHelper.app has disable-library-validation: it must keep full library validation" >&2
  fail=1; loose=1
fi
if [ "$loose" -eq 0 ]; then
  echo "ok   hardened runtime on for ${#runtime_targets[@]} code items; no allow-dyld-environment-variables or get-task-allow; the helper keeps library validation"
fi

exit "$fail"
