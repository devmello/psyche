#!/bin/sh
# Run turbo with one shared, bounded local cache for every checkout and worktree
# (default ~/Library/Caches/psyche/turbo; override TURBO_CACHE_DIR or PSYCHE_CACHE_DIR).
# Cache keys are content hashes, so worktrees at the same commit share hits. The cache is pruned to
# PSYCHE_TURBO_CACHE_MAX_MB (default 5120) before each run; PSYCHE_NO_CACHE_PRUNE=1 skips that.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=scripts/dev/_common.sh
. "$here/_common.sh"

TURBO_CACHE_DIR=${TURBO_CACHE_DIR:-$(psyche_cache_dir)/turbo}
export TURBO_CACHE_DIR
if [ -z "${PSYCHE_NO_CACHE_PRUNE:-}" ] && [ -d "$TURBO_CACHE_DIR" ]; then
  sh "$here/cache-prune.sh" --quiet --if-over || true
fi
exec turbo "$@"
