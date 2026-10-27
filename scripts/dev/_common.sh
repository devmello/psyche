# shellcheck shell=sh
# Shared helpers for scripts/dev/*.sh. Source it; do not run it. POSIX sh, macOS first.

# Where Psyche keeps caches that are shared by every checkout and worktree. Override with PSYCHE_CACHE_DIR.
psyche_cache_dir() {
  if [ -n "${PSYCHE_CACHE_DIR:-}" ]; then
    printf '%s\n' "$PSYCHE_CACHE_DIR"
    return
  fi
  case "$(uname -s)" in
    Darwin) printf '%s\n' "$HOME/Library/Caches/psyche" ;;
    MINGW* | MSYS* | CYGWIN*) printf '%s\n' "${LOCALAPPDATA:-$HOME/AppData/Local}/psyche/cache" ;;
    *) printf '%s\n' "${XDG_CACHE_HOME:-$HOME/.cache}/psyche" ;;
  esac
}

# Directory names that only ever hold build or test output. Never source, never node_modules.
BUILD_OUTPUT_NAMES="dist out .vite .turbo storybook-static test-results playwright-report coverage .build"

# Output directories of the planned native apps (docs/guides/monorepo-layout.md). Their names (bin, obj,
# build) are too generic to match everywhere, so they are listed by path.
NATIVE_OUTPUT_PATHS="apps/windows-helper/bin apps/windows-helper/obj apps/android/build apps/android/app/build apps/android/.gradle apps/ios/build"

# Print every build-output directory under $1, one per line, without descending into node_modules,
# .git, .claude (worktrees) or into a match. Directories with a tracked file in them are skipped.
find_build_outputs() {
  _root=$1
  # shellcheck disable=SC2086
  set -- $BUILD_OUTPUT_NAMES
  _expr=""
  for _n in "$@"; do
    _expr="${_expr:+$_expr -o }-name $_n"
  done
  {
    for _p in $NATIVE_OUTPUT_PATHS; do
      if [ -d "$_root/$_p" ]; then printf '%s\n' "$_root/$_p"; fi
    done
    # shellcheck disable=SC2086
    find "$_root" \( -name node_modules -o -name .git -o -name .claude \) -prune -o \
      -type d \( $_expr \) -print -prune
  } | while IFS= read -r _d; do
    if [ -n "$(git -C "$_root" ls-files -- "$_d" 2>/dev/null | head -n 1)" ]; then
      printf 'skip (tracked files inside): %s\n' "$_d" >&2
      continue
    fi
    printf '%s\n' "$_d"
  done
}

# Size of a path in KiB (0 when it does not exist). Nominal: APFS clones count in full.
kib() {
  [ -e "$1" ] || { echo 0; return; }
  du -sk "$1" 2>/dev/null | awk '{print $1}'
}

# Human-readable size from KiB.
human_kib() {
  awk -v k="$1" 'BEGIN {
    if (k >= 1048576) printf "%.1f GB", k / 1048576
    else if (k >= 1024) printf "%.0f MB", k / 1024
    else printf "%d KB", k
  }'
}

# Copy a tree as an APFS clone (or reflink) when the filesystem can; plain copy otherwise.
clone_copy() {
  cp -cR "$1" "$2" 2>/dev/null && return 0
  cp -R --reflink=auto "$1" "$2" 2>/dev/null && return 0
  cp -R "$1" "$2"
}

# KiB of a checkout without node_modules (at any depth) and without the main checkout's nested .claude.
kib_excluding() {
  if du -sk -I node_modules "$1" >/dev/null 2>&1; then
    du -sk -I node_modules -I .claude "$1" 2>/dev/null | awk '{print $1}'
  else
    du -sk --exclude=node_modules --exclude=.claude "$1" 2>/dev/null | awk '{print $1}'
  fi
}
