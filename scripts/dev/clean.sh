#!/bin/sh
# Remove build outputs from this checkout: dist, out, .vite, .turbo, storybook-static, test-results,
# playwright-report, coverage and .build (the Swift helper's). Never touches source, node_modules
# or .git, and skips any directory that holds a tracked file.
#
#   sh scripts/dev/clean.sh [--dry-run]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=scripts/dev/_common.sh
. "$here/_common.sh"

dry=0
case "${1:-}" in
  -n | --dry-run) dry=1 ;;
  -h | --help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "clean: unknown option $1" >&2; exit 2 ;;
esac

root=$(cd "$here/../.." && pwd)
total=0
list=$(find_build_outputs "$root")
[ -n "$list" ] || { echo "clean: nothing to remove in $root"; exit 0; }
echo "$list" | while IFS= read -r d; do
  kb=$(kib "$d")
  printf '%s %-10s %s\n' "$([ "$dry" = 1 ] && echo would-remove || echo removing)" "$(human_kib "$kb")" "${d#"$root"/}"
  [ "$dry" = 1 ] || rm -rf "$d"
done
