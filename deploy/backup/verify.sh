#!/bin/sh
# Check a backup without restoring it: decrypts, extracts to a scratch dir next to the file and
# compares every file with the manifest's SHA-256. The Gateway keeps running.
#
#   deploy/backup/verify.sh /srv/psyche-backups/psyche-<time>.tar.gz.age [identity-file]
set -eu
. "$(cd "$(dirname "$0")" && pwd)/common.sh"

file="${1:?usage: verify.sh <backup-file> [age-identity-file]}"
identity="${2:-}"
dir="$(cd "$(dirname "$file")" && pwd)"
name="$(basename "$file")"
check_dir "$dir"

if [ -n "$identity" ]; then
  cp "$identity" "$dir/.identity.$$"
  trap 'rm -f "$dir/.identity.$$"' EXIT INT TERM
  psyche_run "$dir" backup verify "/backup/$name" --identity "/backup/.identity.$$"
else
  psyche_run "$dir" backup verify "/backup/$name"
fi
