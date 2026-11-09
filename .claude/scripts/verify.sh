#!/usr/bin/env bash
# Local verification for an agent's branch. GitHub Actions is locked by billing, so this is the gate.
#
# Usage: .claude/scripts/verify.sh [--base <ref>] [--related] [--swift] [--quiet]
#   --base     compare against this ref (default: merge-base with origin/main)
#   --related  also run vitest on tests related to the touched source files
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
related=0
swift=0
quiet=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) base="$2"; shift 2 ;;
    --related) related=1; shift ;;
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

tests="$(echo "$changed" | grep -E '\.(test|spec)\.(ts|tsx|mts)$' || true)"
if [ -n "$tests" ]; then
  # shellcheck disable=SC2086
  run vitest pnpm exec vitest run --maxWorkers=1 $tests
fi
if [ "$related" = 1 ]; then
  srcs="$(echo "$changed" | grep -E '^(apps|packages)/.*\.(ts|tsx)$' | grep -vE '\.(test|spec)\.' || true)"
  # shellcheck disable=SC2086
  [ -n "$srcs" ] && run vitest-related pnpm exec vitest related --run --maxWorkers=1 $srcs
fi

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
for f in "${fail[@]}"; do
  echo "  FAIL  ${f%%|*}  (log: ${f#*|})"
  tail -n 25 "${f#*|}" | sed 's/^/        /'
done
[ "${#fail[@]}" -eq 0 ]
