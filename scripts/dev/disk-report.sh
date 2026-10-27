#!/bin/sh
# Real disk usage of this repo, its worktrees and the shared stores and caches.
#
#   sh scripts/dev/disk-report.sh [--du] [--no-worktrees]
#
# Why not `du`: on APFS, pnpm imports packages from its store as clones (copy-on-write). Clones share
# blocks, so `du` counts every worktree's node_modules in full (about 1.7 GB each) although it adds
# almost nothing to the volume. `du` is therefore only a ceiling (--du prints it; it takes a minute).
# The "unique" column estimates what a worktree really owns:
#   source + build outputs + everything outside node_modules        (always real)
#   + node_modules in full when it sits on a different volume than the pnpm store (no cloning possible)
#   + Electron's dist unless it is a clone from the shared cache (.psyche-dist-source marker)
# Small per-worktree native builds inside node_modules (node-pty, ~1 MB) are ignored.
# Ground truth is the volume: run `df -k /System/Volumes/Data` before and after an operation and diff
# the "Used" column. That is how `pnpm install` cost was measured (see docs/guides/monorepo-layout.md).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=scripts/dev/_common.sh
. "$here/_common.sh"

worktrees=1 nominal=0
for a in "$@"; do
  case $a in
    --no-worktrees) worktrees=0 ;;
    --du) nominal=1 ;;
    -h | --help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "disk-report: unknown option $a" >&2; exit 2 ;;
  esac
done

root=$(cd "$here/../.." && pwd)
dev_of() { stat -f %d "$1" 2>/dev/null || stat -c %d "$1" 2>/dev/null || echo 0; }
row() { printf '  %-34s %10s\n' "$1" "$(human_kib "$2")"; }

store=$(cd "$root" && pnpm store path 2>/dev/null || true)
[ -n "$store" ] || store="$HOME/Library/pnpm/store/v11"
cache=$(psyche_cache_dir)

echo "Volume"
df -h "$root" | awk 'NR == 2 { printf "  %s used of %s (%s full), %s free\n", $3, $2, $5, $4 }'
echo
echo "Shared, one copy for every checkout (not per worktree)"
row "pnpm store" "$(kib "$store")"
row "turbo cache" "$(kib "${TURBO_CACHE_DIR:-$cache/turbo}")"
row "electron dist clones (psyche)" "$(kib "$cache/electron-dist")"
row "electron download cache" "$(kib "$HOME/Library/Caches/electron")"
row "playwright browsers" "$(kib "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/Library/Caches/ms-playwright}")"
row "Xcode DerivedData" "$(kib "$HOME/Library/Developer/Xcode/DerivedData")"
row "SwiftPM cache" "$(kib "$HOME/Library/Caches/org.swift.swiftpm")"
row "Gradle (~/.gradle)" "$(kib "$HOME/.gradle")"
row "NuGet packages" "$(kib "$HOME/.nuget/packages")"
[ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && echo "  note: PLAYWRIGHT_BROWSERS_PATH is set to ${PLAYWRIGHT_BROWSERS_PATH}"

[ "$worktrees" = 1 ] || exit 0
echo
if [ "$nominal" = 1 ]; then
  echo "Checkouts (du = nominal, clones counted in full; unique = estimate of what is really owned)"
  printf '  %-36s %10s %10s  %s\n' checkout du unique notes
else
  echo "Checkouts (unique = estimate of what each one really owns; --du adds the nominal, slow, du column)"
  printf '  %-36s %10s  %s\n' checkout unique notes
fi
store_dev=$(dev_of "$store")
main=$(cd "$(git -C "$root" rev-parse --git-common-dir)/.." && pwd -P)
tmpf=$(mktemp)
git -C "$root" worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r wt; do
  [ -d "$wt" ] || continue
  # Everything except node_modules and the nested .claude/worktrees of the main checkout.
  own=$(kib_excluding "$wt")
  outputs=0
  for d in $(find_build_outputs "$wt" 2>/dev/null); do outputs=$((outputs + $(kib "$d"))); done
  notes=""
  edist=0
  if [ -L "$wt/node_modules" ]; then
    notes="node_modules is a symlink"
  else
    pkg=$(ls -d "$wt"/node_modules/.pnpm/electron@*/node_modules/electron 2>/dev/null | head -n 1 || true)
    if [ -n "$pkg" ] && [ -d "$pkg/dist" ]; then
      if [ -f "$pkg/.psyche-dist-source" ]; then notes="electron dist: clone"; else edist=$(kib "$pkg/dist"); notes="electron dist: own copy"; fi
    fi
  fi
  unique=$((own + edist))
  nmk=0
  if [ "$(dev_of "$wt")" != "$store_dev" ] && [ -d "$wt/node_modules" ] && [ ! -L "$wt/node_modules" ]; then
    nmk=$(kib "$wt/node_modules"); unique=$((unique + nmk)); notes="$notes node_modules cannot clone (other volume)"
  fi
  name=${wt##*/}
  [ "$wt" = "$main" ] && name="(main repo)"
  [ "$wt" = "$root" ] && name="$name (this)"
  if [ "$nominal" = 1 ]; then
    full=$(kib "$wt"); [ "$wt" != "$main" ] || full=$((full - $(kib "$wt/.claude")))
    printf '  %-36s %10s %10s  %s (outputs %s)\n' "$name" "$(human_kib "$full")" "$(human_kib "$unique")" "$notes" "$(human_kib "$outputs")"
    echo "$full $unique" >> "$tmpf"
  else
    printf '  %-36s %10s  %s (outputs %s)\n' "$name" "$(human_kib "$unique")" "$notes" "$(human_kib "$outputs")"
    echo "0 $unique" >> "$tmpf"
  fi
done
if [ "$nominal" = 1 ]; then
  awk '{ d += $1; u += $2 } END { printf "  %-36s %8.1f GB %7.1f GB\n", "total", d / 1048576, u / 1048576 }' "$tmpf"
else
  awk '{ u += $2 } END { printf "  %-36s %7.1f GB\n", "total", u / 1048576 }' "$tmpf"
fi
rm -f "$tmpf"
