#!/bin/sh
# Check out only the part of the monorepo you work on (git sparse-checkout, cone mode).
#
#   sh scripts/dev/sparse.sh <profile> [--dry-run]
#   sh scripts/dev/sparse.sh --list
#
# Profiles:
#   core     TypeScript apps and packages, docs, skills, tests, deploy, CI. No native app folders.
#   mac      core + apps/mac-helper and the shared Swift package (packages/swift).
#   windows  core + apps/windows-helper (C#/.NET).
#   mobile   core + apps/ios, apps/android and the shared Swift package.
#   all      everything (turns sparse-checkout off).
#
# Files in the repo root are always present. Directories that do not exist yet (the native apps are
# planned, see docs/guides/monorepo-layout.md) are accepted and simply match nothing. Sparse-checkout
# is per worktree, so each session picks its own profile. pnpm install never needs the native folders.
set -eu

list_profiles() { sed -n '8,12p' "$0" | sed 's/^# \{0,1\}//'; }

# apps/mac-helper/Sources/PsycheProtocol stays in every profile: `pnpm protocol:gen` writes the Swift structs there.
core_dirs="apps/cli apps/desktop apps/gateway apps/node apps/site apps/web
packages tests scripts docs skills templates deploy .github .changeset .vscode
 apps/mac-helper/Sources/PsycheProtocol"

profile_dirs() {
  case $1 in
    core) echo "$core_dirs" ;;
    mac) echo "$core_dirs apps/mac-helper packages/swift" ;;
    windows) echo "$core_dirs apps/windows-helper" ;;
    mobile) echo "$core_dirs apps/ios apps/android packages/swift" ;;
    *) return 1 ;;
  esac
}

dry=0 profile=""
while [ $# -gt 0 ]; do
  case $1 in
    -n | --dry-run) dry=1 ;;
    --list) list_profiles; exit 0 ;;
    -h | --help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "sparse: unknown option $1" >&2; exit 2 ;;
    *) profile=$1 ;;
  esac
  shift
done
[ -n "$profile" ] || { echo "usage: sparse.sh <core|mac|windows|mobile|all> [--dry-run]" >&2; exit 2; }

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)

if [ "$profile" = all ]; then
  if [ "$dry" = 1 ]; then echo "would run: git sparse-checkout disable"; exit 0; fi
  git -C "$root" sparse-checkout disable
  echo "sparse: full checkout"
  exit 0
fi

dirs=$(profile_dirs "$profile") || { echo "sparse: unknown profile '$profile' (core, mac, windows, mobile, all)" >&2; exit 2; }
# shellcheck disable=SC2086
if [ "$dry" = 1 ]; then
  echo "would run: git sparse-checkout set --cone $(echo $dirs)"
  exit 0
fi
# shellcheck disable=SC2086
git -C "$root" sparse-checkout set --cone $dirs
echo "sparse: profile '$profile' ($(echo "$dirs" | wc -w | tr -d ' ') directories plus root files). 'sh scripts/dev/sparse.sh all' restores everything."
