#!/bin/sh
# Bound the shared Turbo cache: drop entries older than --days (default 14), then the oldest entries
# until the cache is under --max-mb (default $PSYCHE_TURBO_CACHE_MAX_MB or 5120).
#
#   sh scripts/dev/cache-prune.sh [--dry-run] [--days N] [--max-mb N] [--if-over] [--quiet]
#
# --if-over does nothing unless the cache is over the cap (the cheap check turbo.sh runs before a build).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=scripts/dev/_common.sh
. "$here/_common.sh"

dry=0 days=14 max_mb=${PSYCHE_TURBO_CACHE_MAX_MB:-5120} if_over=0 quiet=0
while [ $# -gt 0 ]; do
  case $1 in
    -n | --dry-run) dry=1 ;;
    --days) days=$2; shift ;;
    --max-mb) max_mb=$2; shift ;;
    --if-over) if_over=1 ;;
    -q | --quiet) quiet=1 ;;
    -h | --help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "cache-prune: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

dir=${TURBO_CACHE_DIR:-$(psyche_cache_dir)/turbo}
[ -d "$dir" ] || { [ "$quiet" = 1 ] || echo "cache-prune: no cache at $dir"; exit 0; }

say() { [ "$quiet" = 1 ] || echo "$@"; }
size_kb=$(kib "$dir")
if [ "$if_over" = 1 ] && [ "$size_kb" -le $((max_mb * 1024)) ]; then exit 0; fi
say "cache-prune: $dir is $(human_kib "$size_kb"), cap $max_mb MB, max age $days days"

removed=0
drop() { # $1 = entry hash path (without extension)
  removed=$((removed + 1))
  [ "$dry" = 1 ] || rm -f "$1.tar.zst" "$1-meta.json" "$1-manifest.json"
}

# 1. Too old.
for f in $(find "$dir" -maxdepth 1 -name '*.tar.zst' -mtime +"$days" 2>/dev/null); do
  drop "${f%.tar.zst}"
done

# 2. Oldest first until under the cap (a dry run only reports step 1).
if [ "$dry" = 0 ]; then
  while [ "$(kib "$dir")" -gt $((max_mb * 1024)) ]; do
    oldest=$(ls -tr "$dir"/*.tar.zst 2>/dev/null | head -n 1)
    [ -n "$oldest" ] || break
    drop "${oldest%.tar.zst}"
  done
fi
say "cache-prune: removed $removed entries$([ "$dry" = 1 ] && echo ' (dry run)'), now $(human_kib "$(kib "$dir")")"
