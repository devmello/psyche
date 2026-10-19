#!/bin/sh
# Encrypted backup of a Compose deployment (feature U4; security §14).
#
#   deploy/backup/backup.sh /srv/psyche-backups age1recipient...     # unattended (recommended)
#   PSYCHE_BACKUP_PASSPHRASE=... deploy/backup/backup.sh /srv/psyche-backups
#
# Stops the Gateway, writes psyche-<time>.tar.gz.age (state/, workspace/, vault/, library/,
# audit/, config.json; channel sessions live in state/channels/), starts the Gateway again.
# Keep the age identity (or the passphrase) and the vault recovery key somewhere else.
set -eu
. "$(cd "$(dirname "$0")" && pwd)/common.sh"

dir="${1:?usage: backup.sh <backup-dir> [age-recipient...]}"
shift
check_dir "$dir"
args=""
for r in "$@"; do args="$args --recipient $r"; done
if [ -z "$args" ] && [ -z "${PSYCHE_BACKUP_PASSPHRASE:-}" ]; then
  echo "error: give an age recipient or set PSYCHE_BACKUP_PASSPHRASE" >&2
  exit 2
fi
name="psyche-$(date -u +%Y%m%dT%H%M%SZ).tar.gz.age"

stop_gateway
# shellcheck disable=SC2086 # recipients are age1… tokens without spaces
psyche_run "$dir" backup create --out "/backup/$name" $args
echo "wrote $dir/$name"
