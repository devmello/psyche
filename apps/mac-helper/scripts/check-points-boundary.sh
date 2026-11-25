#!/usr/bin/env bash
# Psyche points never clicks (docs/design/psyche-points-2026.md §4.3). This is the structural check:
# the targets Points may use can read the screen, but cannot link anything that posts an event,
# performs an AX action, activates an app, opens a URL, writes the pasteboard, sends Apple events,
# looks symbols up by name or starts a process.
#
#   1. package graph   no guarded target reaches PsycheHelperSystem (Input, AXEngine.perform/set),
#                      each target's dependencies stay inside its allowlist, unknown kinds fail
#   2. source scan     kAXTrustedCheckOptionPrompt, CGEvent(, .post( (also a Swift test); the Core
#                      protocols that can act (DictationBackend, SessionTapInstaller...) are not
#                      named; main.swift gives PointsCapabilities.make only an allowlist of closures
#   3. AXEnable        the one AXUIElementSetAttributeValue token in all guarded sources is the exact
#                      line setting AXManualAccessibility to kCFBooleanTrue; the object exports one
#                      symbol and links a pinned set of non-Swift symbols
#   4. symbols         nm -u of each guarded target's object: no event, action, spawn, dynamic-lookup,
#                      Apple event, IOKit or trust-prompt API
#   5. classes         no NSTask, NSAppleScript, OSAScript, Apple event or scripting-task classes
#   6. selectors       no forbidden selector, both defined (__objc_methname) and CALLED. Call sites
#                      compile to undefined `_objc_msgSend$<selector>` stubs, which `nm -u` lists;
#                      __objc_methname alone only holds selectors the module defines.
#   7. positive control the same scans, run on PsycheHelperSystem, MUST find _CGEventPost,
#                      _AXUIElementPerformAction, NSTask, OSAScript and the activate / openURL:
#                      selector stubs, or the check itself is broken
#
# Usage: apps/mac-helper/scripts/check-points-boundary.sh [--no-build]
# Exit 0 = boundary holds. Needs swift, nm, otool and python3 (all ship with Xcode / macOS).
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here" || exit 2

build=1
[ "${1:-}" = "--no-build" ] && build=0

# Targets that must never be able to act on another app. AXEnable is guarded too, with the one
# documented exception in step 3. No per-target exceptions exist today; if a guarded target ever
# needs one of the forbidden names, add it here with a comment saying why, never by loosening a list.
guarded=(PsycheHelperPoints PsycheAXRead PsycheCapture PsycheAXEnable PsycheHelperCore)
# Linked in through the package graph (the protocol package): symbol-scanned too, no sources here.
linked_deps=(PsycheProtocol PsycheWire)
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
        if "byName" in d:
            names.append(d["byName"][0])
        elif "target" in d:
            names.append(d["target"][0])
        elif "product" in d:
            # (product name, package): the protocol products must come from protocol-swift.
            if d["product"][1] != "protocol-swift":
                print(f"{t['name']} uses product {d['product'][0]} from package {d['product'][1]!r}, not protocol-swift")
            names.append(d["product"][0])
        else:
            print(f"{t['name']} has a dependency of unknown kind {sorted(d)}; teach the check about it")
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
            seen.add(d)
            closure(d, seen)
    return seen
for t, allowed in allow.items():
    if t not in deps:
        print(f"{t} is missing from Package.swift")
        continue
    extra = set(deps[t]) - allowed
    if extra:
        print(f"{t} depends on {sorted(extra)}; allowed: {sorted(allowed)}")
    if "PsycheHelperSystem" in closure(t):
        print(f"{t} reaches PsycheHelperSystem")
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

# Core exports protocols that act (typing, event taps, guest operations). The targets other than
# Core must not name them, so main.swift cannot inject one into Points.
acting_names='DictationBackend|DictationInserter|SessionTapInstaller|KeyDownGate|GuestOperations'
noncore_dirs=()
for t in "${guarded[@]}"; do [ "$t" = PsycheHelperCore ] || noncore_dirs+=("Sources/$t"); done
acting_hits="$(grep -rnwE --include='*.swift' "$acting_names" "${noncore_dirs[@]}" 2>/dev/null || true)"
if [ -n "$acting_hits" ]; then
  while IFS= read -r l; do fail "acting Core type named outside Core: $l"; done <<<"$acting_hits"
else
  ok "no Points-side source names an acting Core type"
fi

# What main.swift hands Points: nothing today; later only the isComputerBusy and isRecording closures.
main_calls="$(grep -n 'PointsCapabilities' Sources/PsycheHelper/main.swift || true)"
n_calls="$(grep -c . <<<"$main_calls")"
# The text after `PointsCapabilities.make(` up to the end of the line: the closing parentheses of
# the call (and of the enclosing call) must follow the allowlisted closures directly.
args="$(sed -n 's/.*PointsCapabilities\.make(//p' <<<"$main_calls" | sed -n '1p')"
call_pat='^((isComputerBusy|isRecording): *\{[^{}]*\}(, *(isComputerBusy|isRecording): *\{[^{}]*\})?)?\)+$'
if [ -z "$main_calls" ] || [ "$n_calls" != 1 ] || ! grep -q 'PointsCapabilities\.make(' <<<"$main_calls" || ! grep -qE "$call_pat" <<<"$args"; then
  fail "main.swift must call PointsCapabilities.make exactly once, with no arguments or only isComputerBusy / isRecording closures: $main_calls"
else
  ok "main.swift passes Points only an allowlisted argument list"
fi

# ---- 3. the one AXEnable call --------------------------------------------------------------------
# Every non-comment occurrence of the token, not only `Name(`: `let f = AXUIElementSetAttributeValue`
# would otherwise slip through.
set_tokens="$(grep -rn --include='*.swift' 'AXUIElementSetAttributeValue' "${src_dirs[@]}" 2>/dev/null | grep -vE '^[^:]+:[0-9]+:[[:space:]]*//' || true)"
n_set=0
[ -n "$set_tokens" ] && n_set="$(wc -l <<<"$set_tokens" | tr -d ' ')"
exact_call='^Sources/PsycheAXEnable/AXEnable\.swift:[0-9]+:    _ = AXUIElementSetAttributeValue\(app, "AXManualAccessibility" as CFString, kCFBooleanTrue\)$'
if [ "$n_set" != 1 ] || ! grep -qE "$exact_call" <<<"$set_tokens"; then
  fail "AXUIElementSetAttributeValue must appear exactly once, as the AXManualAccessibility / kCFBooleanTrue line in PsycheAXEnable (found $n_set): $set_tokens"
else
  ok "AXEnable keeps one AXUIElementSetAttributeValue token, the literal AXManualAccessibility call"
fi

# ---- objects -------------------------------------------------------------------------------------
if [ "$build" = 1 ]; then
  swift build >/dev/null 2>&1 || { fail "swift build failed, so the object scans cannot run"; echo "boundary: $failures failure(s)" >&2; exit 1; }
fi
bin="$(swift build --show-bin-path 2>/dev/null)"
objects_of() {  # prints the object files of one target (one merged .o, or the per-file objects)
  if [ -f "$bin/$1.o" ]; then echo "$bin/$1.o"; else find "$bin/$1.build" -name '*.o' 2>/dev/null; fi
}
undefined_symbols() { objects_of "$1" | while IFS= read -r o; do nm -u "$o" 2>/dev/null; done | sort -u; }
# Selectors defined by the module plus selectors it calls (the `_objc_msgSend$<selector>` stubs).
objc_selectors() {
  { objects_of "$1" | while IFS= read -r o; do otool -v -s __TEXT __objc_methname "$o" 2>/dev/null; done | awk 'NF == 2 { print $2 }' | grep -vE '^performSelector'
    # (Defined performSelector: names are NSObjectProtocol requirements Core's metadata lists; only a CALL counts.)
    undefined_symbols "$1" | sed -n 's/^_objc_msgSend\$//p'
  } | sort -u
}

forbidden_symbols='^_(CGEventPost|CGEventPostToPid|CGEventPostToPSN|CGEventTapCreate|CGEventTapCreateForPid|CGEventTapPostEvent|CGEventCreateKeyboardEvent|CGEventCreateMouseEvent|CGEventCreateScrollWheelEvent[0-9]*|CGWarpMouseCursorPosition|CGDisplayMoveCursorToPoint|AXUIElementPerformAction|AXUIElementPostKeyboardEvent|AXUIElementSetAttributeValue|IOHIDPostEvent|CGRequestScreenCaptureAccess|AXIsProcessTrustedWithOptions|kAXTrustedCheckOptionPrompt|dlsym|dlopen|NSClassFromString|NSSelectorFromString|NSProtocolFromString|objc_getClass|objc_lookUpClass|sel_registerName|sel_getUid|CFBundleGetFunctionPointerForName|AESend[A-Za-z]*|AECreateAppleEvent|LSOpen[A-Za-z]*|exec(l|le|lp|v|ve|vp|vP)?|fork|vfork|popen|system|posix_spawn[A-Za-z_]*|IOConnectCall[A-Za-z]*|IOServiceOpen|\$s10ObjectiveC8SelectorVyACSScfC|objc_getRequiredClass|objc_getMetaClass|objc_getClassList|objc_copyClassList|class_getMethodImplementation|class_getInstanceMethod|class_getClassMethod|method_getImplementation)$'
forbidden_classes='^_OBJC_CLASS_\$_(NSAppleScript|OSAScript|NSTask|NSAppleEventDescriptor|NSAppleEventManager|SBApplication|NSUserScriptTask|NSUserAppleScriptTask|NSUserAutomatorTask|NSUserUnixTask)$'
forbidden_selectors='^(postEvent:atStart:|sendEvent:|sendEventWithOptions:timeout:error:|activateIgnoringOtherApps:|activateWithOptions:|activate|activateFileViewerSelectingURLs:|makeKeyWindow|makeKeyAndOrderFront:|openURL:|openURL:configuration:completionHandler:|openURLs:withApplicationAtURL:configuration:completionHandler:|openApplicationAtURL:configuration:completionHandler:|openFile:|openFile:withApplication:|launchApplication[A-Za-z:]*|launchAndReturnError:|hide|unhide|terminate|forceTerminate|setString:forType:|setData:forType:|writeObjects:|characters|charactersIgnoringModifiers|performSelector:[A-Za-z:]*|classNamed:|principalClass|setPropertyList:forType:|declareTypes:owner:)$'
# The only non-Swift undefined symbols PsycheAXEnable may link.
axenable_symbols='_AXUIElementCreateApplication _AXUIElementSetAttributeValue _AXUIElementSetMessagingTimeout _kCFBooleanTrue _objc_release _objc_retain'
axenable_export='_$s14PsycheAXEnable25enableManualAccessibility3pidys5Int32V_tF'

for t in "${guarded[@]}" "${linked_deps[@]}"; do
  if [ -z "$(objects_of "$t")" ]; then fail "no object files for $t under $bin"; continue; fi
  syms="$(undefined_symbols "$t")"
  # Fail closed: an object with no readable undefined symbols means nm broke, not that it is clean.
  if [ -z "$syms" ]; then fail "nm -u returned nothing for $t, the symbol scan is blind"; continue; fi
  # ---- 4. symbols (PsycheAXEnable alone may set one attribute, pinned in step 3) ----
  hits="$(grep -E "$forbidden_symbols" <<<"$syms" || true)"
  if [ "$t" = PsycheAXEnable ]; then hits="$(grep -v '^_AXUIElementSetAttributeValue$' <<<"$hits" || true)"; fi
  if [ -n "$hits" ]; then fail "$t links forbidden symbols: $(echo "$hits" | tr '\n' ' ')"; else ok "$t symbols"; fi
  # ---- 5. classes ----
  hits="$(grep -E "$forbidden_classes" <<<"$syms" || true)"
  if [ -n "$hits" ]; then fail "$t references forbidden classes: $(echo "$hits" | tr '\n' ' ')"; else ok "$t classes"; fi
  # ---- 6. selectors (defined and called) ----
  hits="$(objc_selectors "$t" | grep -E "$forbidden_selectors" || true)"
  if [ -n "$hits" ]; then fail "$t uses forbidden selectors: $(echo "$hits" | tr '\n' ' ')"; else ok "$t selectors"; fi
done

# ---- 3b. the AXEnable object itself --------------------------------------------------------------
ax_obj_exports="$(objects_of PsycheAXEnable | while IFS= read -r o; do nm -gU "$o" 2>/dev/null; done | awk 'NF == 3 { print $3 }' | sort -u)"
if [ "$ax_obj_exports" != "$axenable_export" ]; then
  fail "PsycheAXEnable must export exactly enableManualAccessibility(pid:), found: $(echo "$ax_obj_exports" | tr '\n' ' ')"
else
  ok "PsycheAXEnable exports only enableManualAccessibility(pid:)"
fi
ax_c_syms="$(undefined_symbols PsycheAXEnable | grep -vE '^_?_\$s|^__swift_FORCE_LOAD_|^_swift_' | tr '\n' ' ' | sed 's/ $//')"
if [ "$ax_c_syms" != "$axenable_symbols" ]; then
  fail "PsycheAXEnable non-Swift undefined symbols changed: wanted [$axenable_symbols], found [$ax_c_syms]"
else
  ok "PsycheAXEnable links only its pinned non-Swift symbols"
fi

# ---- 3c. the Points object's exports ------------------------------------------------------------
# main.swift gives Points nothing today, and the label check in step 2 cannot see argument TYPES: a
# closure `(Double, Double) -> Bool` would let main.swift post a click inside it. So the exported
# surface of PsycheHelperPoints is pinned: PointsCapabilities.make() with no arguments (plus its
# type metadata). W3 MUST update this pin when it adds the closures, to
#   make(isComputerBusy: @escaping @Sendable () -> Bool, isRecording: @escaping @Sendable () -> Bool)
# and every other exported Points symbol it adds (reviewed one by one, never by loosening this).
points_exports_want='_$s18PsycheHelperPoints0C12CapabilitiesO4makeSay0aB4Core17CapabilityHandler_pGyFZ
_$s18PsycheHelperPoints0C12CapabilitiesOMa
_$s18PsycheHelperPoints0C12CapabilitiesOMn
_$s18PsycheHelperPoints0C12CapabilitiesON'
points_exports="$(objects_of PsycheHelperPoints | while IFS= read -r o; do nm -gU "$o" 2>/dev/null; done | awk 'NF == 3 { print $3 }' | sort -u)"
if [ "$points_exports" != "$points_exports_want" ]; then
  fail "PsycheHelperPoints exports changed (W3 must update the pin in this script): found $(echo "$points_exports" | tr '\n' ' ')"
else
  ok "PsycheHelperPoints exports only PointsCapabilities.make() with no arguments"
fi

# ---- 7. positive control -------------------------------------------------------------------------
sys_syms="$(undefined_symbols PsycheHelperSystem)"
for want in '_CGEventPost' '_AXUIElementPerformAction' '_OBJC_CLASS_$_NSTask' '_OBJC_CLASS_$_OSAScript'; do
  if grep -qxF "$want" <<<"$sys_syms"; then ok "positive control: PsycheHelperSystem references $want"; else fail "positive control: $want not found in PsycheHelperSystem, the symbol or class scan is broken"; fi
done
sys_sels="$(objc_selectors PsycheHelperSystem)"
for want in 'activate' 'openURL:'; do
  if grep -qxF "$want" <<<"$sys_sels"; then ok "positive control: PsycheHelperSystem uses selector $want"; else fail "positive control: selector $want not found in PsycheHelperSystem, the selector scan is blind"; fi
done

if [ "$failures" -gt 0 ]; then
  echo "boundary: $failures failure(s)" >&2
  exit 1
fi
echo "boundary: all checks passed"
