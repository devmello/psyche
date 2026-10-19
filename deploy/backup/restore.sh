#!/bin/sh
# Restore a backup into a Compose deployment's volume.
#
#   deploy/backup/restore.sh /srv/psyche-backups/psyche-<time>.tar.gz.age [identity-file]
#
# Verifies every file first. Existing state is moved to $PSYCHE_HOME/.pre-restore-<time>/.
# On a new machine, unlock the vault afterwards with its recovery key:
#   docker compose -f deploy/docker-compose.yml exec gateway psyche vault unlock --recovery
set -eu
. "$(cd "$(dirname "$0")" && pwd)/common.sh"

file="${1:?usage: restore.sh <backup-file> [age-identity-file]}"
identity="${2:-}"
dir="$(cd "$(dirname "$file")" && pwd)"
name="$(basename "$file")"
check_dir "$dir"

stop_gateway
if [ -n "$identity" ]; then
  cp "$identity" "$dir/.identity.$$"
  trap 'rm -f "$dir/.identity.$$"; compose start "$service" >/dev/null' EXIT INT TERM
  psyche_run "$dir" backup restore "/backup/$name" --force --identity "/backup/.identity.$$"
else
  psyche_run "$dir" backup restore "/backup/$name" --force
fi
echo "restored $file"
