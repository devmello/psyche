#!/usr/bin/env bash
# Local verification for an agent's branch. GitHub Actions is locked by billing, so this is the gate.
#
# Usage: .claude/scripts/verify.sh [--base <ref>] [--no-related] [--swift] [--quiet]
#   --base        compare against this ref (default: merge-base with origin/main)
#   --no-related  skip vitest on existing tests that import the touched source files (on by
#                 default: builders twice broke existing tests they never ran, #1299 and #1300)
#   --swift    also build and test touched Swift packages (waits for any other Swift build first)
#   --quiet    print only the summary and failures
#
# Checks only what the branch touched:
#   - biome on the touched files
#   - secret-grep on the whole repo
#   - protocol:check if packages/protocol changed
#   - i18n:check if any TS/TSX or message file changed
#   - typecheck for each touched package
#   - vitest (one worker) on touched test files
# Never runs `pnpm -w typecheck` or `pnpm -r test`.
# Exit 0 means every check passed. On failure, it prints the failures, and the last
# lines of each failing log are what the Stop hook feeds back to the agent.
set -o pipefail  # no -u: macOS bash 3.2 treats empty arrays as unbound

cd "$(git rev-parse --show-toplevel)" || exit 2

base=""
related=1
swift=0
quiet=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) base="$2"; shift 2 ;;
    --related) related=1; shift ;;
    --no-related) related=0; shift ;;
    --swift) swift=1; shift ;;
    --quiet) quiet=1; shift ;;
    *) echo "verify.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
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

if echo "$changed" | grep -q '^packages/protocol/'; then
  run protocol-check pnpm run protocol:check
fi

if echo "$changed" | grep -qE '\.(ts|tsx)$|\.xcstrings$'; then
  run i18n-check pnpm run i18n:check
fi

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
# A failing file is re-run once (flake filter), then run on the merge base: failures that also
# happen on the base are reported as pre-existing and do not fail the check.
warn=()
failed_files() { # failed_files <vitest json> -> absolute paths of failed test files
  node -e 'try{const r=require(process.argv[1]);for(const t of r.testResults||[])if(t.status==="failed")console.log(t.name)}catch{}' "$1"
}
base_tree() { # base_tree -> path of a worktree at $base with deps installed (cached per commit)
  local common sha dir
  common="$(cd "$(git rev-parse --git-common-dir)" && pwd)/agent-verify/base"
  sha="$(git rev-parse --short=12 "$base")"
  dir="$common/$sha"
  mkdir -p "$common"
  find "$common" -mindepth 1 -maxdepth 1 -type d -mtime +2 -exec git worktree remove --force {} \; 2>/dev/null
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
    continue
  fi
  [ $? -eq 0 ] && { pass+=("$name"); continue; }
  bad="$(failed_files "$log.json")"
  [ -n "$bad" ] || { fail+=("$name|$log.log"); continue; }  # crashed before reporting: real failure
  # shellcheck disable=SC2086
  (cd "$pkg" && pnpm exec vitest run --maxWorkers=1 --reporter=default --reporter=json \
    --outputFile.json="$log.rerun.json" $bad) >"$log.rerun.log" 2>&1 && { warn+=("$name: flaky, passed on re-run: $(echo $bad | xargs -n1 basename | paste -sd' ' -)"); pass+=("$name"); continue; }
  bad="$(failed_files "$log.rerun.json")"
  own=""
  pre=""
  if bt="$(base_tree)"; then
    for f in $bad; do
      rel="${f#"$PWD/"}"
      if [ -f "$bt/$rel" ] && ! (cd "$bt/$pkg" && pnpm exec vitest run --maxWorkers=1 "${rel#"$pkg/"}") >/dev/null 2>&1; then
        pre="$pre $(basename "$rel")"
      else
        own="$own $rel"
      fi
    done
  else
    own="$bad"
    warn+=("$name: could not set up the base worktree to tell pre-existing failures apart")
  fi
  [ -n "$pre" ] && warn+=("$name: also failing on the base (pre-existing, not yours):$pre")
  if [ -n "$own" ]; then fail+=("$name|$log.rerun.log"); else pass+=("$name"); fi
done
# Tests outside apps/ and packages/ (tests/acceptance, tests/integration): run what was touched.
other="$(echo "$changed" | grep -E '^tests/.*\.(test|spec)\.(ts|tsx|mts)$' || true)"
# shellcheck disable=SC2086
[ -n "$other" ] && run vitest:tests pnpm exec vitest run --maxWorkers=1 $other

if [ "$swift" = 1 ]; then
  for pkg in apps/mac-helper packages/protocol-swift; do
    echo "$changed" | grep -q "^$pkg/" || continue
    while pgrep -f 'swift-build|xcodebuild' >/dev/null; do sleep 15; done  # one Swift build at a time
    run "swift-test:$pkg" bash -c "cd '$pkg' && swift build && swift test"
  done
elif echo "$changed" | grep -qE '\.swift$'; then
  echo "verify: Swift files changed; run again with --swift to build and test them."
fi

echo
echo "verify: ${#pass[@]} passed, ${#fail[@]} failed (files checked: $(echo "$changed" | wc -l | tr -d ' '))"
for p in "${pass[@]}"; do [ "$quiet" = 1 ] || echo "  ok    $p"; done
for w in "${warn[@]}"; do echo "  note  $w"; done
for f in "${fail[@]}"; do
  echo "  FAIL  ${f%%|*}  (log: ${f#*|})"
  tail -n 25 "${f#*|}" | sed 's/^/        /'
done
[ "${#fail[@]}" -eq 0 ]
