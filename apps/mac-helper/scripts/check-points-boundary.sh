#!/usr/bin/env bash
# Psyche points never clicks (docs/design/psyche-points-2026.md §4.3). This is the structural check:
# the targets Points may use can read the screen, but cannot link anything that posts an event,
# performs an AX action, activates an app, opens a URL or starts a process.
#
#   1. package graph   no guarded target reaches PsycheHelperSystem (Input, AXEngine.perform/set),
#                      and each target's dependencies stay inside its allowlist
#   2. source scan     kAXTrustedCheckOptionPrompt, CGEvent(, .post( (also a Swift test)
#   3. AXEnable        exactly one AXUIElementSetAttributeValue call, in PsycheAXEnable only
#   4. symbols         nm -u of each guarded target's object: no event, action, spawn or prompt API
#   5. classes         no NSTask, NSAppleScript or OSAScript
#   6. selectors       no postEvent:atStart:, sendEvent:, activate..., openURL:, characters...
#   7. positive control the same scans, run on PsycheHelperSystem, MUST find _CGEventPost,
#                      _AXUIElementPerformAction, NSTask and OSAScript, or the check itself is broken
#
# Usage: apps/mac-helper/scripts/check-points-boundary.sh [--no-build]
# Exit 0 = boundary holds. Needs swift, nm, otool and python3 (all ship with Xcode / macOS).
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here" || exit 2

build=1
[ "${1:-}" = "--no-build" ] && build=0

# Targets that must never be able to act on another app. AXEnable is guarded too, with the one
# documented exception in step 4.
guarded=(PsycheHelperPoints PsycheAXRead PsycheCapture PsycheAXEnable PsycheHelperCore)
failures=0
fail() { echo "boundary: FAIL: $*" >&2; failures=$((failures + 1)); }
ok() { echo "boundary: ok: $*"; }

# ---- 1. package graph ----------------------------------------------------------------------------
graph_json="$(swift package dump-package 2>/dev/null)" || { echo "boundary: swift package dump-package failed" >&2; exit 2; }
graph_out="$(GRAPH="$graph_json" python3 -I - <<'PY'
import json, os
pkg = json.loads(os.environ["GRAPH"])
deps = {}
for t in pkg["targets"]:
    names = []
    for d in t.get("dependencies", []):
        if "byName" in d: names.append(d["byName"][0])
        elif "target" in d: names.append(d["target"][0])
        elif "product" in d: names.append(d["product"][0])
    deps[t["name"]] = names
allow = {
    "PsycheAXRead": set(),
    "PsycheAXEnable": set(),
    "PsycheCapture": {"PsycheHelperCore"},
    "PsycheHelperCore": {"PsycheProtocol", "PsycheWire"},
    "PsycheHelperPoints": {"PsycheHelperCore", "PsycheAXRead", "PsycheCapture", "PsycheAXEnable", "PsycheProtocol", "PsycheWire"},
}
def closure(t, seen=None):
    seen = set() if seen is None else seen
    for d in deps.get(t, []):
        if d not in seen:
            seen.add(d); closure(d, seen)
    return seen
for t, ok in allow.items():
    if t not in deps:
        print(f"{t} is missing from Package.swift"); continue
    extra = set(deps[t]) - ok
    if extra: print(f"{t} depends on {sorted(extra)}; allowed: {sorted(ok)}")
    if "PsycheHelperSystem" in closure(t): print(f"{t} reaches PsycheHelperSystem")
PY
)"
if [ -n "$graph_out" ]; then
  while IFS= read -r l; do fail "package graph: $l"; done <<<"$graph_out"
else
  ok "package graph (${guarded[*]} cannot reach PsycheHelperSystem)"
fi

# ---- 2. source scan ------------------------------------------------------------------------------
src_dirs=()
for t in "${guarded[@]}"; do src_dirs+=("Sources/$t"); done
scan_hits="$(grep -rnE --include='*.swift' 'kAXTrustedCheckOptionPrompt|CGEvent\(|\.post\(' "${src_dirs[@]}" 2>/dev/null || true)"
if [ -n "$scan_hits" ]; then
  while IFS= read -r l; do fail "source scan: $l"; done <<<"$scan_hits"
else
  ok "source scan (no kAXTrustedCheckOptionPrompt, CGEvent( or .post()"
fi

# ---- 3. the one AXEnable call --------------------------------------------------------------------
set_calls="$(grep -rnE --include='*.swift' 'AXUIElementSetAttributeValue\(' "${src_dirs[@]}" 2>/dev/null | grep -vE '^[^:]+:[0-9]+:[[:space:]]*//' || true)"
n_set=0
[ -n "$set_calls" ] && n_set="$(wc -l <<<"$set_calls" | tr -d ' ')"
if [ "$n_set" != 1 ] || ! grep -q '^Sources/PsycheAXEnable/' <<<"$set_calls"; then
  fail "AXUIElementSetAttributeValue must be called exactly once, in PsycheAXEnable (found $n_set): $set_calls"
else
  ok "AXEnable keeps a single AXUIElementSetAttributeValue call"
fi

# ---- objects -------------------------------------------------------------------------------------
if [ "$build" = 1 ]; then
  swift build >/dev/null 2>&1 || { echo "boundary: swift build failed" >&2; exit 2; }
fi
bin="$(swift build --show-bin-path 2>/dev/null)"
objects_of() {  # prints the object files of one target (one merged .o, or the per-file objects)
  if [ -f "$bin/$1.o" ]; then echo "$bin/$1.o"; else find "$bin/$1.build" -name '*.o' 2>/dev/null; fi
}
undefined_symbols() { objects_of "$1" | while IFS= read -r o; do nm -u "$o" 2>/dev/null; done | sort -u; }
objc_selectors() { objects_of "$1" | while IFS= read -r o; do otool -v -s __TEXT __objc_methname "$o" 2>/dev/null; done | awk 'NF == 2 { print $2 }' | sort -u; }

forbidden_symbols='^_(CGEventPost|CGEventPostToPid|CGEventPostToPSN|CGEventTapCreate|CGEventTapCreateForPid|CGEventTapPostEvent|CGEventCreateKeyboardEvent|CGEventCreateMouseEvent|CGEventCreateScrollWheelEvent[0-9]*|CGWarpMouseCursorPosition|CGDisplayMoveCursorToPoint|AXUIElementPerformAction|AXUIElementPostKeyboardEvent|AXUIElementSetAttributeValue|IOHIDPostEvent|CGRequestScreenCaptureAccess|posix_spawn[A-Za-z_]*)$'
forbidden_classes='^_OBJC_CLASS_\$_(NSAppleScript|OSAScript|NSTask)$'
forbidden_selectors='^(postEvent:atStart:|sendEvent:|activateIgnoringOtherApps:|activateWithOptions:|activate|makeKeyWindow|makeKeyAndOrderFront:|openURL:|openApplicationAtURL:configuration:completionHandler:|characters|charactersIgnoringModifiers)$'

for t in "${guarded[@]}"; do
  if [ -z "$(objects_of "$t")" ]; then fail "no object files for $t under $bin"; continue; fi
  syms="$(undefined_symbols "$t")"
  # ---- 4. symbols (PsycheAXEnable alone may set one attribute) ----
  hits="$(grep -E "$forbidden_symbols" <<<"$syms" || true)"
  if [ "$t" = PsycheAXEnable ]; then hits="$(grep -v '^_AXUIElementSetAttributeValue$' <<<"$hits" || true)"; fi
  if [ -n "$hits" ]; then fail "$t links forbidden symbols: $(echo "$hits" | tr '\n' ' ')"; else ok "$t symbols"; fi
  # ---- 5. classes ----
  hits="$(grep -E "$forbidden_classes" <<<"$syms" || true)"
  if [ -n "$hits" ]; then fail "$t references forbidden classes: $(echo "$hits" | tr '\n' ' ')"; else ok "$t classes"; fi
  # ---- 6. selectors ----
  hits="$(objc_selectors "$t" | grep -E "$forbidden_selectors" || true)"
  if [ -n "$hits" ]; then fail "$t uses forbidden selectors: $(echo "$hits" | tr '\n' ' ')"; else ok "$t selectors"; fi
done

# Control for the selector reader: Core has Objective-C selectors, so an empty list means otool broke.
[ -n "$(objc_selectors PsycheHelperCore)" ] || fail "positive control: otool returned no selectors for PsycheHelperCore, the selector scan is blind"

# ---- 7. positive control -------------------------------------------------------------------------
sys_syms="$(undefined_symbols PsycheHelperSystem)"
for want in '_CGEventPost' '_AXUIElementPerformAction'; do
  if grep -qxF "$want" <<<"$sys_syms"; then ok "positive control: PsycheHelperSystem links $want"; else fail "positive control: $want not found in PsycheHelperSystem, the symbol scan is broken"; fi
done
for want in '_OBJC_CLASS_$_NSTask' '_OBJC_CLASS_$_OSAScript'; do
  if grep -qxF "$want" <<<"$sys_syms"; then ok "positive control: PsycheHelperSystem references $want"; else fail "positive control: $want not found in PsycheHelperSystem, the class scan is broken"; fi
done

if [ "$failures" -gt 0 ]; then
  echo "boundary: $failures failure(s)" >&2
  exit 1
fi
echo "boundary: all checks passed"
