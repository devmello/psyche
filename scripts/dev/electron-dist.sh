#!/bin/sh
# Keep Electron's ~308 MB `dist` out of every worktree's real disk usage.
#
# Electron 44 has no install script: the `dist` directory is extracted into the package the first
# time anything requires `electron` (electron/index.js), so pnpm's side-effects cache can never hold
# it. This script keeps one extracted copy per Electron version in the shared cache and gives each
# worktree an APFS clone of it (shares blocks, costs ~0 until modified).
#
#   sh scripts/dev/electron-dist.sh          link: clone the shared copy in, or seed it from this worktree's dist.
#                                            Never downloads. Runs from the root `postinstall`.
#   sh scripts/dev/electron-dist.sh prime    link, and if there is no copy anywhere, extract once (needs the
#                                            Electron zip in ~/Library/Caches/electron or network) and share it.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=scripts/dev/_common.sh
. "$here/_common.sh"

mode=${1:-link}
# CI and Linux servers skip the binary on purpose.
[ -z "${ELECTRON_SKIP_BINARY_DOWNLOAD:-}" ] || exit 0

root=$(cd "$here/../.." && pwd)
pkg=$(cd "$root/apps/desktop" 2>/dev/null && node -e "process.stdout.write(require('path').dirname(require.resolve('electron/package.json')))" 2>/dev/null) || exit 0
[ -n "$pkg" ] && [ -f "$pkg/install.js" ] || exit 0

version=$(node -p "require('$pkg/package.json').version")
key="electron-$version-$(node -p 'process.platform + "-" + process.arch')"
store="$(psyche_cache_dir)/electron-dist/$key"
marker="$pkg/.psyche-dist-source"

if [ ! -f "$pkg/path.txt" ] || [ ! -d "$pkg/dist" ]; then
  if [ -f "$store/path.txt" ] && [ -d "$store/dist" ]; then
    rm -rf "$pkg/dist"
    clone_copy "$store/dist" "$pkg/dist"
    cp "$store/path.txt" "$pkg/path.txt"
    echo "clone:$key" > "$marker"
    echo "electron-dist: cloned $key from the shared cache"
    exit 0
  fi
  if [ "$mode" = prime ]; then
    node "$pkg/install.js"
  else
    exit 0
  fi
fi

# This worktree has a dist; seed the shared copy from it so the next worktree can clone.
if [ ! -f "$store/path.txt" ]; then
  mkdir -p "$store"
  clone_copy "$pkg/dist" "$store/dist.tmp.$$"
  mv "$store/dist.tmp.$$" "$store/dist"
  cp "$pkg/path.txt" "$store/path.txt"
  echo "electron-dist: seeded the shared cache with $key ($store)"
fi
