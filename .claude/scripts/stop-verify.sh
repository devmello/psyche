#!/usr/bin/env bash
# Stop hook: the verification loop. When an agent tries to end its turn in a worktree with
# unverified changes, run .claude/scripts/verify.sh. If it fails, block the stop and hand the
# failures back so the agent fixes them. Then it tries to stop again, and this runs again.
#
# - Runs only inside a git worktree under .claude/worktrees/. The orchestrator's main checkout
#   is skipped.
# - Skips when nothing changed since the last passing run (the state hash matches).
# - Gives up after 3 blocks in a row on the same failure, so a stuck agent can stop and
#   report the failure honestly instead of looping forever.
# - Off switch: PSYCHE_VERIFY_HOOK=off, or touch "$(git rev-parse --git-dir)/agent-verify/off".
set -o pipefail  # no -u: macOS bash 3.2 treats empty arrays as unbound

input="$(cat)"
[ "${PSYCHE_VERIFY_HOOK:-on}" = off ] && exit 0
here="$(cd "$(dirname "$0")" && pwd)"

# Hooks can run with the project's root folder as their working directory rather than the
# session's worktree (seen in the 2026-11-09 trials), so use the session's cwd from the input.
hook_cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
[ -n "$hook_cwd" ] && [ -d "$hook_cwd" ] && cd "$hook_cwd"
top="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
# One line per invocation, in the shared git dir, so a hook that never fires (or skips) is visible.
log="$(cd "$(git rev-parse --git-common-dir)" && pwd)/agent-verify/hook.log"
mkdir -p "$(dirname "$log")"
printf '%s\tcwd=%s\ttop=%s\tactive=%s\n' "$(date -u +%FT%TZ)" "$hook_cwd" "$top" \
  "$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)" >>"$log"
case "$top" in */.claude/worktrees/*) ;; *) exit 0 ;; esac
cd "$top" || exit 0

state="$(git rev-parse --git-dir)/agent-verify"
mkdir -p "$state"
[ -e "$state/off" ] && exit 0

hash="$( { git rev-parse HEAD; git diff HEAD; git ls-files --others --exclude-standard -z | xargs -0 shasum 2>/dev/null; } | shasum | cut -c1-16 )"
[ "$(cat "$state/passed" 2>/dev/null)" = "$hash" ] && exit 0

base="$(git merge-base HEAD origin/main 2>/dev/null || echo HEAD)"
if [ -z "$( { git diff --name-only "$base"...HEAD; git diff --name-only HEAD; git ls-files --others --exclude-standard; } 2>/dev/null)" ]; then
  exit 0
fi

# The branch's own verify.sh if it has one (it may be newer), else the one next to this hook.
vs=".claude/scripts/verify.sh"
[ -f "$vs" ] || vs="$here/verify.sh"
out="$(bash "$vs" --quiet 2>&1)"
if [ $? -eq 0 ]; then
  echo "$hash" >"$state/passed"
  rm -f "$state/blocks"
  exit 0
fi

blocks=$(( $(cat "$state/blocks" 2>/dev/null || echo 0) + 1 ))
echo "$blocks" >"$state/blocks"
# Record failures in the shared git dir (it outlives the worktree) so the reflect skill can find
# recurring ones later.
common="$(cd "$(git rev-parse --git-common-dir)" && pwd)/agent-verify"
mkdir -p "$common"
printf '%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$(git branch --show-current)" \
  "$(echo "$out" | grep -E '^  FAIL' | awk '{print $2}' | paste -sd, -)" >>"$common/failures.tsv"

if [ "$blocks" -gt 3 ]; then
  rm -f "$state/blocks"
  # Let it stop; the agent must report the failure rather than claim success.
  jq -n --arg m "verify.sh still fails after 3 fix attempts. Say so plainly in your report, with the failing check names." \
    '{systemMessage: $m}'
  exit 0
fi

reason="Local verification failed (attempt $blocks of 3). Fix these, then finish. Do not skip or weaken tests to make them pass.
$(echo "$out" | tail -n 80)"
jq -n --arg r "$reason" '{decision: "block", reason: $r}'
exit 0
