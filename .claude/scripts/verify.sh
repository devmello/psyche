#!/usr/bin/env bash
# Local verification for an agent's branch. GitHub Actions is locked by billing, so this is the gate.
#
# Usage: .claude/scripts/verify.sh [--quick] [--related] [--base <ref>] [--swift] [--quiet]
#   --quick    lint-level checks only (biome, secret-grep, protocol and i18n checks): seconds, no
#              typecheck, no tests. The Stop hook uses this.
#   --related  also run existing tests that import the touched source files (`vitest related`).
#              It also runs the app test files that import a touched packages/<pkg>/src package
#              (capped by PSYCHE_VERIFY_DEP_CAP, default 60). The slowest stage: it is for the
#              one merge-gate run of a PR, not for builders.
#   --base     compare against this ref (default: merge-base with origin/main)
#   --swift    also build and test touched Swift packages (waits for any other Swift build first)
#   --quiet    print only the summary and failures
#   (--no-related is accepted and is now the default.)
#
# Checks only what the branch touched:
#   - biome on the touched files
#   - secret-grep on the whole repo
#   - protocol:check if packages/protocol changed
#   - i18n:check if any TS/TSX or message file changed
#   - xcstrings-coverage (all 11 locales per translated key) for each touched iOS catalog
#   - typecheck for each touched package (not with --quick)
#   - vitest (one worker) on touched test files plus the same-named test of each touched source
#     file (x.ts -> x.test.ts); `--related` adds every importer (not with --quick)
#   - platform-linux/windows tests when packages/ui/src/i18n/messages/** changed (not with --quick)
# Never runs `pnpm -w typecheck` or `pnpm -r test`.
#
# The owner's rule (2026-11-18): don't overheat the Mac with checks after every small fix. So the
# full check runs at low priority (nice 10), and only a few full checks (see the slots below) run at once:
# others wait their turn instead of running side by side.
# Exit 0 means every check passed. On failure, it prints the failures, and the last
# lines of each failing log are what the Stop hook feeds back to the agent.
set -o pipefail  # no -u: macOS bash 3.2 treats empty arrays as unbound

cd "$(git rev-parse --show-toplevel)" || exit 2

# A session started before nvm's default Node changed keeps the old Node on PATH, and that Node
# may have no pnpm any more (2026-11-19: v24.18.0 lost it after the owner moved to v24.22.3).
# Every check would then fail with "pnpm: command not found", so use nvm's default Node instead.
if ! command -v pnpm >/dev/null 2>&1; then
  nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  default="$(cat "$nvm_dir/alias/default" 2>/dev/null)"
  for bin in "$nvm_dir"/versions/node/v"${default#v}"*/bin "$nvm_dir"/versions/node/*/bin; do
    if [ -x "$bin/pnpm" ]; then
      PATH="$bin:$PATH"
      export PATH
      echo "verify: pnpm wasn't on PATH; using $bin" >&2
      break
    fi
  done
  command -v pnpm >/dev/null 2>&1 || { echo "verify: pnpm not found; run scripts/dev/new-mac/1-node.sh" >&2; exit 2; }
fi

base=""
related=0
quick=0
swift=0
quiet=0
args=("$@")
while [ $# -gt 0 ]; do
  case "$1" in
    --base) base="$2"; shift 2 ;;
    --quick) quick=1; shift ;;
    --related) related=1; shift ;;
    --no-related) related=0; shift ;;
    --swift) swift=1; shift ;;
    --quiet) quiet=1; shift ;;
    *) echo "verify.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

# Low priority for everything, so a check never fights the owner's own work for the CPU.
if [ -z "${VERIFY_NICED:-}" ] && command -v nice >/dev/null; then
  VERIFY_NICED=1 exec nice -n 10 bash "$0" "${args[@]}"
fi

# A few full checks at a time on this Mac, never more. Each slot is a lock dir in the shared git
# dir, so every worktree sees them; a slot whose owner process is gone is taken over. The owner's
# rule (2026-11-18) was one at a time on the old Mac; on the M4 Pro (2026-11-19, "do what you will
# with that") machines with 10+ cores get 3 slots. 2026-11-19 evening, the owner had more compute
# to spare: with 18 runs queued the load sat near 6 on 12 cores, so 12+ cores with 24+ GB get 5.
# PSYCHE_VERIFY_SLOTS overrides.
if [ "$quick" = 0 ]; then
  slots="${PSYCHE_VERIFY_SLOTS:-}"
  if [ -z "$slots" ]; then
    cores="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 1)"
    mem_gb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))
    if [ "$cores" -ge 12 ] 2>/dev/null && [ "$mem_gb" -ge 24 ] 2>/dev/null; then slots=8
    elif [ "$cores" -ge 10 ] 2>/dev/null; then slots=3
    else slots=1; fi
  fi
  lockdir="$(cd "$(git rev-parse --git-common-dir)" && pwd)/agent-verify"
  mkdir -p "$lockdir"
  said=0
  lock=""
  while [ -z "$lock" ]; do
    i=1
    while [ "$i" -le "$slots" ]; do
      # Slot 1 keeps the old name, so a check from an older script still counts against it.
      if [ "$i" = 1 ]; then try="$lockdir/full.lock"; else try="$lockdir/full.lock.$i"; fi
      if mkdir "$try" 2>/dev/null; then lock="$try"; break; fi
      holder="$(cat "$try/pid" 2>/dev/null)"
      if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$try"; continue; fi
      i=$((i + 1))
    done
    if [ -z "$lock" ]; then
      [ "$said" = 1 ] || { echo "verify: all $slots full-check slots are busy; waiting for one"; said=1; }
      sleep 10
    fi
  done
  echo $$ >"$lock/pid"
  trap 'rm -rf "$lock"' EXIT
fi
[ -n "$base" ] || base="$(git merge-base HEAD origin/main 2>/dev/null || echo HEAD)"

logdir="$(git rev-parse --git-dir)/agent-verify"
mkdir -p "$logdir"

# Touched files: committed since base, plus staged, unstaged and untracked.
changed="$( { git diff --name-only "$base"...HEAD 2>/dev/null; git diff --name-only HEAD; git ls-files --others --exclude-standard; } \
  | sort -u | while read -r f; do [ -f "$f" ] && echo "$f"; done )"

if [ -z "$changed" ]; then
  echo "verify: nothing changed since $(git rev-parse --short "$base"), nothing to check."
  exit 0
fi

pass=()
fail=()
run() { # run <name> <cmd...>
  local name="$1"; shift
  local log="$logdir/${name//[^A-Za-z0-9_.-]/_}.log"
  [ "$quiet" = 1 ] || echo "verify: $name"
  if "$@" >"$log" 2>&1; then pass+=("$name"); else fail+=("$name|$log"); fi
}

code_files="$(echo "$changed" | grep -E '\.(ts|tsx|js|mjs|cjs|jsx|json|jsonc|css)$' || true)"
if [ -n "$code_files" ]; then
  # shellcheck disable=SC2086
  run biome pnpm exec biome check --diagnostic-level=error --no-errors-on-unmatched --files-ignore-unknown=true $code_files
fi

run secret-grep bash scripts/ci/secret-grep.sh

if grep -q '^packages/protocol/' <<<"$changed"; then
  run protocol-check pnpm run protocol:check
fi

if grep -qE '\.(ts|tsx)$|\.xcstrings$' <<<"$changed"; then
  run i18n-check pnpm run i18n:check
fi

# iOS catalogs: i18n:check never reads them (#1542 shipped keys without zh-Hans). Every translated
# key needs all 11 locales; only the touched catalogs are read, so this takes milliseconds.
xc="$(echo "$changed" | grep -E '\.xcstrings$' || true)"
# shellcheck disable=SC2086
[ -n "$xc" ] && run xcstrings-coverage python3 -I .claude/scripts/xcstrings-coverage.py $xc

warn=()
if [ "$quick" = 0 ]; then
# Typecheck each touched workspace package that has a typecheck script.
pkgs="$(echo "$changed" | grep -E '^(apps|packages)/[^/]+/' | cut -d/ -f1-2 | sort -u)"
for dir in $pkgs; do
  [ -f "$dir/package.json" ] || continue
  name="$(node -e "const p=require('./$dir/package.json');process.stdout.write(p.scripts&&p.scripts.typecheck?p.name:'')")"
  [ -n "$name" ] && run "typecheck:$name" pnpm --filter "$name" run typecheck
done

# Tests, per touched package: the touched test files, plus (by default) every existing test in
# that package whose import graph reaches a touched source file (`vitest related`, run from the
# package so it stays inside it; repo-wide related on a widely imported file runs for many
# minutes). Builders broke existing tests they never ran in #1299 and #1300; this catches that.
# A failing file is re-run once (flake filter), then run on the merge base: a file whose failing
# tests (by name) all fail on the base too is reported as pre-existing and does not fail the
# check. Any failing test the base doesn't share fails it.
failed_files() { # failed_files <vitest json> -> absolute paths of failed test files
  node -e 'try{const r=require(process.argv[1]);for(const t of r.testResults||[])if(t.status==="failed")console.log(t.name)}catch{}' "$1"
}
# new_failures <branch json> <abs test file> <base json> -> the file's failing tests (full names)
# that do not also fail on the base. Compared per test, not per file: in #1301 a file that already
# failed on the base hid two new failures in it. A file that fails to load counts as one test,
# "(file failed to load)". An unreadable base result counts every failure as new.
new_failures() {
  node -e '
    const names = (t) => {
      const f = (t.assertionResults || []).filter((a) => a.status === "failed").map((a) => a.fullName);
      return f.length > 0 || t.status !== "failed" ? f : ["(file failed to load)"];
    };
    let br, bs;
    try { br = require(process.argv[1]); } catch { process.exit(0); }
    try { bs = new Set((require(process.argv[3]).testResults || []).flatMap(names)); } catch { bs = new Set(); }
    for (const t of br.testResults || [])
      if (t.name === process.argv[2]) for (const n of names(t)) if (!bs.has(n)) console.log(n);
  ' "$1" "$2" "$3"
}
# base_unloadable <base json> <abs test file> -> prints "yes" when the base run could not tell us
# anything about this file: no result at all, or the file failed to load (no assertions ran).
# The new branch's failure is then "unknown whether pre-existing", not "new".
base_unloadable() {
  node -e '
    let r; try { r = require(process.argv[1]); } catch { console.log("yes"); process.exit(0); }
    const base = (r.testResults || []).find((t) => t.name.endsWith(process.argv[2]));
    if (!base || (base.status === "failed" && (base.assertionResults || []).length === 0)) console.log("yes");
  ' "$1" "$2"
}
base_tree() { # base_tree -> path of a worktree at $base with deps installed (cached per commit)
  # Not under .git: Vite treats a `.git` path segment as denied, and vitest then cannot load
  # setupFiles ("Cannot find module '/test/setup.ts'", #1309), so every failure looked new.
  # The main checkout's .claude/worktrees/ is gitignored and has no `.git` segment.
  local root common sha dir old
  common="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
  root="${VERIFY_BASE_DIR:-$(dirname "$common")/.claude/worktrees/_verify-base}"
  sha="$(git rev-parse --short=12 "$base")"
  dir="$root/$sha"
  mkdir -p "$root"
  for old in "$common"/agent-verify/base/*/; do  # drop trees from before the move
    [ -d "$old" ] && { git worktree remove --force "$old" 2>/dev/null || rm -rf "$old"; }
  done
  find "$root" -mindepth 1 -maxdepth 1 -type d -mtime +2 -exec git worktree remove --force {} \; 2>/dev/null
  if [ ! -f "$dir/.verify-ready" ]; then
    git worktree add --detach "$dir" "$base" >/dev/null 2>&1 || [ -d "$dir" ] || return 1
    (cd "$dir" && pnpm install --frozen-lockfile --prefer-offline >/dev/null 2>&1) || return 1
    touch "$dir/.verify-ready"
  fi
  echo "$dir"
}
test_pkgs="$(echo "$changed" | grep -E '^(apps|packages)/[^/]+/.*\.(ts|tsx|mts)$' | grep -v '\.d\.ts$' | cut -d/ -f1-2 | sort -u)"
for pkg in $test_pkgs; do
  [ -f "$pkg/package.json" ] || continue
  files="$(echo "$changed" | grep -E "^$pkg/.*\.(ts|tsx|mts)$" | grep -v '\.d\.ts$' | sed "s#^$pkg/##")"
  tfiles="$(echo "$files" | grep -E '\.(test|spec)\.' || true)"
  # Source-sibling tests: for each touched non-test source file, also run the tracked test whose
  # name matches it (`x.ts` -> `x.test.ts`, in the same dir or the package's test/). Light (a few
  # files, no import graph), and #1361 hid 9 exec-host failures without it.
  sib=""
  tracked="$(git ls-files "$pkg" | grep -E '\.(test|spec)\.(ts|tsx|mts)$' || true)"
  for sf in $(echo "$files" | grep -vE '\.(test|spec)\.' || true); do
    b="$(basename "${sf%.*}")"
    sib="$sib
$(echo "$tracked" | grep -E "/$b\.(test|spec)\.(ts|tsx|mts)$" | sed "s#^$pkg/##")"
  done
  tfiles="$(printf '%s\n%s\n' "$tfiles" "$sib" | grep -v '^$' | sort -u || true)"
  name="vitest:$pkg"
  log="$logdir/${name//[^A-Za-z0-9_.-]/_}"
  [ "$quiet" = 1 ] || echo "verify: $name"
  # shellcheck disable=SC2086
  if [ "$related" = 1 ]; then
    (cd "$pkg" && pnpm exec vitest related --run --passWithNoTests --maxWorkers=1 \
      --reporter=default --reporter=json --outputFile.json="$log.json" $files) >"$log.log" 2>&1
  elif [ -n "$tfiles" ]; then
    (cd "$pkg" && pnpm exec vitest run --passWithNoTests --maxWorkers=1 \
      --reporter=default --reporter=json --outputFile.json="$log.json" $tfiles) >"$log.log" 2>&1
  else
    # Touched source with no test of its own or beside it: say so, rather than announce a step
    # and record nothing (it read like a lost result).
    warn+=("$name: no tests for the touched files (run --related to include importers)")
    continue
  fi
  [ $? -eq 0 ] && { pass+=("$name"); continue; }
  bad="$(failed_files "$log.json")"
  [ -n "$bad" ] || { fail+=("$name|$log.log"); continue; }  # crashed before reporting: real failure
  # shellcheck disable=SC2086
  (cd "$pkg" && pnpm exec vitest run --maxWorkers=1 --reporter=default --reporter=json \
    --outputFile.json="$log.rerun.json" $bad) >"$log.rerun.log" 2>&1 && { warn+=("$name: flaky, passed on re-run: $(echo $bad | xargs -n1 basename | paste -sd' ' -)"); pass+=("$name"); continue; }
  bad="$(failed_files "$log.rerun.json")"
  [ -n "$bad" ] || { fail+=("$name|$log.rerun.log"); continue; }  # re-run crashed before reporting
  own=""
  pre=""
  if bt="$(base_tree)"; then
    for f in $bad; do
      rel="${f#"$PWD/"}"
      if [ ! -f "$bt/$rel" ]; then own="$own $rel"; continue; fi
      bj="$log.base.json"
      rm -f "$bj"
      (cd "$bt/$pkg" && pnpm exec vitest run --maxWorkers=1 --reporter=json --outputFile.json="$bj" \
        "${rel#"$pkg/"}") >/dev/null 2>&1
      new="$(new_failures "$log.rerun.json" "$f" "$bj")"
      if [ -z "$new" ]; then
        pre="$pre $(basename "$rel")"
      else
        own="$own $rel"
        echo "$new" | sed "s#^#        new in $(basename "$rel"): #" >>"$log.rerun.log"
        if [ -n "$(base_unloadable "$bj" "$rel")" ]; then  # still a failure, but say we can't tell
          echo "        base could not run $(basename "$rel"): unknown whether these also fail on main, not proven new" >>"$log.rerun.log"
          warn+=("$name: base could not run $(basename "$rel") (see its log); check by running it on origin/main")
        fi
      fi
    done
  else
    own="$bad"
    warn+=("$name: could not set up the base worktree to tell pre-existing failures apart")
  fi
  [ -n "$pre" ] && warn+=("$name: also failing on the base (pre-existing, not yours):$pre")
  if [ -n "$own" ]; then fail+=("$name|$log.rerun.log"); else pass+=("$name"); fi
done
# Dependent app tests (--related only). A change to packages/<pkg>/src can break an app test that
# imports @psyche/<pkg>, and the per-package run above never reaches it: #1437 broke
# apps/gateway/test/context.test.ts this way. So for each touched shared package, run the app test
# files that import it directly (git grep, not the whole app suite). Capped at PSYCHE_VERIFY_DEP_CAP
# files (default 60); a longer list is cut and noted. A failure is compared with the base, as above.
if [ "$related" = 1 ]; then
dep_cap="${PSYCHE_VERIFY_DEP_CAP:-60}"
dep_list=""
for dpkg in $(echo "$changed" | grep -E '^packages/[^/]+/src/.*\.(ts|tsx|mts)$' | grep -vE '\.(test|spec)\.' | cut -d/ -f2 | sort -u); do
  npm_name="$(node -e "const p=require('./packages/$dpkg/package.json');process.stdout.write(p.name||'')" 2>/dev/null)"
  [ -n "$npm_name" ] || continue
  hits="$(git grep -l -E "[\"']${npm_name}[\"'/]" -- 'apps/*/test/*' 2>/dev/null | grep -E '\.(test|spec)\.(ts|tsx|mts)$' || true)"
  dep_list="$dep_list
$hits"
done
dep_list="$(echo "$dep_list" | grep -v '^$' | sort -u || true)"
dep_total="$(echo "$dep_list" | grep -c . || true)"
if [ "$dep_total" -gt "$dep_cap" ]; then
  warn+=("dependents: $dep_total app test files import a touched shared package; ran the first $dep_cap (PSYCHE_VERIFY_DEP_CAP)")
  dep_list="$(echo "$dep_list" | head -n "$dep_cap")"
fi
for app in $(echo "$dep_list" | grep . | cut -d/ -f2 | sort -u); do
  files="$(echo "$dep_list" | grep "^apps/$app/" | sed "s#^apps/$app/##")"
  name="vitest-dependents:$app"
  log="$logdir/${name//[^A-Za-z0-9_.-]/_}"
  [ "$quiet" = 1 ] || echo "verify: $name ($(echo "$files" | grep -c .) test files import a touched package)"
  # shellcheck disable=SC2086
  (cd "apps/$app" && pnpm exec vitest run --passWithNoTests --maxWorkers=1 \
    --reporter=default --reporter=json --outputFile.json="$log.json" $files) >"$log.log" 2>&1
  [ $? -eq 0 ] && { pass+=("$name"); continue; }
  bad="$(failed_files "$log.json")"
  [ -n "$bad" ] || { fail+=("$name|$log.log"); continue; }  # crashed before reporting: real failure
  own=""
  pre=""
  if bt="$(base_tree)"; then
    for f in $bad; do
      rel="${f#"$PWD/apps/$app/"}"
      bj="$log.base.$(basename "$rel").json"
      rm -f "$bj"
      (cd "$bt/apps/$app" && pnpm exec vitest run --maxWorkers=1 --reporter=json --outputFile.json="$bj" \
        "$rel") >/dev/null 2>&1
      new="$(new_failures "$log.json" "$f" "$bj")"
      if [ -z "$new" ]; then
        pre="$pre $rel"
      else
        own="$own $rel"
        echo "$new" | sed "s#^#        new in $rel: #" >>"$log.log"
      fi
    done
  else
    own="$bad"
    warn+=("$name: could not set up the base worktree to tell pre-existing failures apart")
  fi
  [ -n "$pre" ] && warn+=("$name: also failing on the base (pre-existing, not yours):$pre")
  if [ -n "$own" ]; then fail+=("$name|$log.log"); else pass+=("$name"); fi
done
fi
# Message files that name Mac or Touch ID need Linux/Windows variants; `vitest related` misses
# the platform tests (#1338 broke main), so always run them when the messages change.
if grep -q '^packages/ui/src/i18n/messages/' <<<"$changed"; then
  run vitest:ui-platform bash -c "cd packages/ui && pnpm exec vitest run --maxWorkers=1 test/platform-linux.test.tsx test/platform-windows.test.tsx"
fi
# Tests outside apps/ and packages/ (tests/acceptance, tests/integration): run what was touched.
other="$(echo "$changed" | grep -E '^tests/.*\.(test|spec)\.(ts|tsx|mts)$' || true)"
# shellcheck disable=SC2086
[ -n "$other" ] && run vitest:tests pnpm exec vitest run --maxWorkers=1 $other

# One Swift build at a time on this Mac. Match the build processes by exact name: `pgrep -f` also
# matched any shell whose command line mentions them (other sessions' wrappers) and waited forever.
wait_for_swift_builds() {
  while pgrep -x swift-build >/dev/null || pgrep -x xcodebuild >/dev/null; do sleep 15; done
}

if [ "$swift" = 1 ]; then
  for pkg in apps/mac-helper packages/protocol-swift; do
    grep -q "^$pkg/" <<<"$changed" || continue
    wait_for_swift_builds
    run "swift-test:$pkg" bash -c "cd '$pkg' && swift build && swift test"
  done
  # The iOS package's test targets (host macOS, no simulator, no UI tests). It also depends on
  # packages/protocol-swift, so a protocol change runs it too.
  if grep -qE '^(apps/ios|packages/protocol-swift)/' <<<"$changed"; then
    wait_for_swift_builds
    run "swift-test:apps/ios" bash -c "cd 'apps/ios' && swift test"
  fi
elif grep -qE '\.swift$' <<<"$changed"; then
  echo "verify: Swift files changed; run again with --swift to build and test them."
fi
fi  # quick

mode="full"
[ "$quick" = 1 ] && mode="quick"
[ "$related" = 1 ] && [ "$quick" = 0 ] && mode="full + related"
echo
echo "verify ($mode): ${#pass[@]} passed, ${#fail[@]} failed (files checked: $(echo "$changed" | wc -l | tr -d ' '))"
for p in "${pass[@]}"; do [ "$quiet" = 1 ] || echo "  ok    $p"; done
for w in "${warn[@]}"; do echo "  note  $w"; done
for f in "${fail[@]}"; do
  echo "  FAIL  ${f%%|*}  (log: ${f#*|})"
  tail -n 25 "${f#*|}" | sed 's/^/        /'
done
[ "${#fail[@]}" -eq 0 ]
