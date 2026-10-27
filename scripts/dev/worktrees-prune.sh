#!/bin/sh
# Remove Claude session worktrees (.claude/worktrees/*) that are finished, then `git worktree prune`.
#
#   sh scripts/dev/worktrees-prune.sh [--yes] [--base REF] [--idle-minutes N] [--no-fetch] [--no-gh] [--deep] [--only NAME]
#
# Without --yes it only prints what it would remove. A worktree is removed only when ALL hold:
#   - merged: its HEAD is an ancestor of the base (default origin/main), or `gh` says a PR from its
#     branch was merged with exactly this HEAD (covers squash merges);
#   - clean: no uncommitted or untracked files (ignored files such as node_modules do not count);
#   - not in use: no process has it as its working directory or an open file in its top level
#     (--deep also runs the slow `lsof +D`), and its git index/HEAD were not touched in the last
#     --idle-minutes (default 120). A session that was just created at origin/main is "merged" too,
#     the idle check is what protects it;
#   - not locked, and not the worktree you are running this from.
# --only NAME limits the run to the one worktree directory with that name.
# Branches are kept (they are cheap); `git worktree remove` is never forced.
set -eu

yes=0 base=origin/main idle=120 fetch=1 use_gh=1 deep=0 only=""
while [ $# -gt 0 ]; do
  case $1 in
    --yes | -y) yes=1 ;;
    --base) base=$2; shift ;;
    --idle-minutes) idle=$2; shift ;;
    --no-fetch) fetch=0 ;;
    --no-gh) use_gh=0 ;;
    --deep) deep=1 ;;
    --only) only=$2; shift ;;
    -h | --help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "worktrees-prune: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

here=$(cd "$(dirname "$0")" && pwd)
self=$(cd "$here/../.." && pwd -P)
if [ "$fetch" = 1 ]; then
  git -C "$self" fetch --quiet origin main 2>/dev/null || echo "worktrees-prune: could not fetch origin (using the local $base)" >&2
fi
git -C "$self" rev-parse --verify --quiet "$base^{commit}" >/dev/null || { echo "worktrees-prune: $base not found" >&2; exit 1; }
if [ "$use_gh" = 1 ] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then have_gh=1; else have_gh=0; fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
# Working directories of every process we can see, one lsof call for all worktrees.
lsof -n -w -a -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' > "$tmp/cwds" || : > "$tmp/cwds"

in_use() { # $1 = worktree path
  awk -v p="$1" 'index($0, p) == 1 && (length($0) == length(p) || substr($0, length(p) + 1, 1) == "/") { f = 1 } END { exit !f }' "$tmp/cwds" && return 0
  [ -n "$(lsof -n -w -t +d "$1" 2>/dev/null | head -n 1)" ] && return 0
  [ "$deep" = 1 ] && [ -n "$(lsof -n -w -t +D "$1" 2>/dev/null | head -n 1)" ] && return 0
  return 1
}

recently_touched() { # $1 = worktree path
  gd=$(git -C "$1" rev-parse --absolute-git-dir 2>/dev/null) || return 1
  [ -n "$(find "$gd" -maxdepth 1 \( -name index -o -name HEAD \) -mmin -"$idle" 2>/dev/null | head -n 1)" ] && return 0
  [ -n "$(find "$gd/logs" -maxdepth 1 -name HEAD -mmin -"$idle" 2>/dev/null | head -n 1)" ] && return 0
  return 1
}

# decide PATH HEAD BRANCH LOCKED -> sets verdict (remove|skip) and why
decide() {
  wt=$1 head=$2 branch=$3 locked=$4
  verdict=skip
  [ "$locked" = 0 ] || { why="locked"; return; }
  [ -d "$wt" ] || { why="directory missing (git worktree prune clears it)"; return; }
  merged=""
  if git -C "$self" merge-base --is-ancestor "$head" "$base" 2>/dev/null; then
    merged="HEAD is in $base"
  elif [ "$have_gh" = 1 ] && [ -n "$branch" ]; then
    n=$(gh pr list --head "$branch" --state merged --limit 5 --json headRefOid -q "map(select(.headRefOid == \"$head\")) | length" 2>/dev/null || echo 0)
    [ "${n:-0}" -gt 0 ] && merged="PR from $branch is merged"
  fi
  [ -n "$merged" ] || { why="not merged into $base"; return; }
  recently_touched "$wt" && { why="git index/HEAD touched in the last $idle min (session may be active)"; return; }
  in_use "$wt" && { why="in use by a running process"; return; }
  [ -z "$(GIT_OPTIONAL_LOCKS=0 git -C "$wt" status --porcelain 2>/dev/null | head -n 1)" ] || { why="uncommitted or untracked changes"; return; }
  verdict=remove why="$merged"
}

git -C "$self" worktree list --porcelain > "$tmp/list"
echo >> "$tmp/list"
: > "$tmp/remove"
nrem=0 nskip=0
wt="" head="" branch="" locked=0
while IFS= read -r line; do
  case $line in
    "worktree "*) wt=${line#worktree } ;;
    "HEAD "*) head=${line#HEAD } ;;
    "branch "*) branch=${line#branch refs/heads/} ;;
    locked*) locked=1 ;;
    "")
      if [ -n "$wt" ]; then
        case $wt in
          */.claude/worktrees/*)
            if [ "$(cd "$wt" 2>/dev/null && pwd -P || echo "$wt")" = "$self" ] || { [ -n "$only" ] && [ "${wt##*/}" != "$only" ]; }; then
              :
            else
              decide "$wt" "$head" "$branch" "$locked"
              if [ "$verdict" = remove ]; then
                nrem=$((nrem + 1)); echo "$wt" >> "$tmp/remove"
                printf 'REMOVE  %s  (%s)\n' "${wt##*/}" "$why"
              else
                nskip=$((nskip + 1))
                printf 'skip    %s  (%s)\n' "${wt##*/}" "$why"
              fi
            fi ;;
        esac
      fi
      wt="" head="" branch="" locked=0 ;;
  esac
done < "$tmp/list"

echo
echo "$nrem to remove, $nskip kept."
if [ "$yes" = 0 ]; then
  [ "$nrem" = 0 ] || echo "Dry run. Re-run with --yes to remove them."
  git -C "$self" worktree prune --dry-run -v
  exit 0
fi

failed=0
while IFS= read -r wt; do
  [ -n "$wt" ] || continue
  if git -C "$self" worktree remove "$wt"; then echo "removed ${wt##*/}"; else echo "FAILED  ${wt##*/} (left in place)" >&2; failed=$((failed + 1)); fi
done < "$tmp/remove"
git -C "$self" worktree prune -v
[ "$failed" = 0 ]
