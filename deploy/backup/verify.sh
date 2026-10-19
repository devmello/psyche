#!/bin/sh
# Check a backup without restoring it: decrypts, extracts to a scratch dir inside the volume
# ($PSYCHE_HOME, 0700) and compares every file with the manifest's SHA-256. The Gateway keeps
# running.
#
#   deploy/backup/verify.sh /srv/psyche-backups/psyche-<time>.tar.gz.age [identity-file]
set -eu
. "$(cd "$(dirname "$0")" && pwd)/common.sh"

file="${1:?usage: verify.sh <backup-file> [age-identity-file]}"
identity="${2:-}"
file="$(abspath "$file")"
dir="$(dirname "$file")"
name="$(basename "$file")"
check_dir "$dir"

if [ -n "$identity" ]; then
  # The identity goes in on stdin: never copied next to the backup or into the container.
  psyche_run "$dir" backup verify "/backup/$name" --identity - <"$identity"
else
  psyche_run "$dir" backup verify "/backup/$name"
fi
