# Shared by backup.sh, restore.sh and verify.sh (Compose deployments). Sourced, not run.
# COMPOSE_FILE    default: deploy/docker-compose.yml next to this script
# PSYCHE_SERVICE  default: gateway
here="$(cd "$(dirname "$0")" && pwd)"
compose_file="${COMPOSE_FILE:-$here/../docker-compose.yml}"
service="${PSYCHE_SERVICE:-gateway}"

compose() {
  docker compose -f "$compose_file" "$@"
}

# The image runs as uid 10001; the backup directory must be writable by it.
check_dir() {
  dir="$1"
  if [ ! -d "$dir" ]; then
    echo "error: $dir does not exist. Create it once with:" >&2
    echo "  sudo install -d -o 10001 -g 10001 -m 700 $dir" >&2
    exit 2
  fi
}

# Absolute path without entering the directory: it is owned by uid 10001, mode 0700.
abspath() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$(pwd)" "$1" ;;
  esac
}

# psyche inside a one-off container sharing the Gateway's volume; the backup dir is /backup.
psyche_run() {
  dir="$1"
  shift
  compose run --rm --no-deps -T \
    -e PSYCHE_BACKUP_PASSPHRASE \
    -v "$dir:/backup" \
    --entrypoint psyche "$service" "$@"
}

# Stop the Gateway for a consistent SQLite snapshot and always start it again.
stop_gateway() {
  compose stop "$service"
  trap 'compose start "$service" >/dev/null' EXIT INT TERM
}
