# shellcheck shell=bash
# Shared helpers for the spike-02 sandbox backend scripts. Source it after setting BACKEND.
# Works with macOS /bin/bash 3.2 (no associative arrays, no EPOCHREALTIME).
#
# Backends:
#   apple   Apple `container` CLI (macOS 26+, one lightweight VM per container)
#   docker  the current Docker context (OrbStack, Docker Desktop, ...)
#   colima  Docker against the `colima` context (start it with `colima start --vm-type vz`)

set -u

IMAGE=${IMAGE:-psyche-sandbox:spike}
SPIKE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RESULTS_DIR=${RESULTS_DIR:-$SPIKE_DIR/results}
mkdir -p "$RESULTS_DIR"

case "${BACKEND:?set BACKEND to apple, docker or colima}" in
  apple) CLI=container ;;
  docker) CLI=docker ;;
  colima) CLI=docker; export DOCKER_CONTEXT=colima ;;
  *) echo "unknown backend: $BACKEND" >&2; exit 2 ;;
esac

# Milliseconds since the epoch (perl ships with macOS; bash 3.2 has no EPOCHREALTIME).
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'; }

# Host-side watchdog: run argv with a hard wall-clock limit (seconds). Exit 142 on SIGALRM.
with_timeout() { local s=$1; shift; perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$s" "$@"; }

log() { printf '[%s %s] %s\n' "$BACKEND" "$(date +%H:%M:%S)" "$*" >&2; }

# The per-task contract from docs/02-architecture.md section 9, expressed per backend.
# Prints one flag per line so callers can read it into an array without word-splitting issues.
sandbox_flags() {
  local network=${1:-none}
  case $BACKEND in
    apple)
      if [ "$network" = socket ]; then
        # Egress through a --publish-socket bridge (egress/socket-bridge.py): network stays
        # none, but the published socket must live on the container's own rootfs (it does not
        # work on a tmpfs or a volume), so the rootfs stays writable and every system
        # directory is made read-only instead. The socket lives in /run/psyche (owned by UID
        # 1000 in the image); UID 1000 can write only there, /tmp (tmpfs) and /workspace.
        printf '%s\n' --progress none --network none --cap-drop ALL --uid 1000 --gid 1000 \
          --memory 512M --cpus 1 --ulimit nproc=128:128 --tmpfs /tmp:size=64m
        for d in /usr /etc /bin /sbin /lib /opt /var /home /root /srv /mnt /media; do
          printf '%s\n' --read-only-path "$d"
        done
        return
      fi
      # No --pids-limit: RLIMIT_NPROC for UID 1000 is equivalent because nothing else runs as
      # that UID inside the per-container VM. No no-new-privileges flag: the image has no
      # setuid/setgid binaries and the bounding set is empty.
      printf '%s\n' --progress none --network "$network" --read-only --cap-drop ALL \
        --uid 1000 --gid 1000 --memory 512M --cpus 1 --ulimit nproc=128:128 \
        --tmpfs /tmp:size=64m
      [ "$network" != none ] && printf '%s\n' --no-dns
      ;;
    docker|colima)
      printf '%s\n' --network "$network" --read-only --cap-drop ALL \
        --security-opt no-new-privileges --user 1000:1000 --memory 512m --memory-swap 512m \
        --cpus 1 --pids-limit 128 --tmpfs /tmp:rw,nosuid,nodev,size=64m
      ;;
  esac
}

read_flags() { # read_flags <network> -> sets FLAGS array
  FLAGS=()
  local f
  while IFS= read -r f; do FLAGS+=("$f"); done < <(sandbox_flags "${1:-none}")
}

# Create a persistent workspace volume owned by UID 1000.
vol_create() {
  local name=$1
  case $BACKEND in
    apple)
      # Apple volumes are ext4 block devices with a size cap; the root dir comes up root:root,
      # so a one-shot root init container hands it to UID 1000.
      container volume create -s "${VOLUME_SIZE:-2G}" "$name" >/dev/null || return 1
      with_timeout 60 container run --rm --progress none --network none --uid 0 --gid 0 \
        -v "$name:/workspace" "$IMAGE" chown 1000:1000 /workspace </dev/null
      ;;
    docker|colima)
      # Docker copies the image's /workspace ownership (1000:1000) into a new named volume.
      docker volume create "$name" >/dev/null
      ;;
  esac
}

vol_rm() { $CLI volume rm "$1" >/dev/null 2>&1 || true; }

# Start a long-lived per-task container: sbx_start <name> <volume> [network] [extra run args...]
sbx_start() {
  local name=$1 vol=$2 network=${3:-none}
  shift 3 2>/dev/null || shift $#
  read_flags "$network"
  with_timeout 120 $CLI run -d --name "$name" "${FLAGS[@]}" -v "$vol:/workspace" -w /workspace \
    "$@" "$IMAGE" sleep infinity </dev/null >/dev/null
}

# Run one bounded command: sbx_exec <name> <seconds> <bash command string>.
# The bound is enforced twice: coreutils `timeout` inside the container (TERM, then KILL after
# 2 s) and a host watchdog 5 s later in case the exec channel itself hangs.
sbx_exec() {
  local name=$1 secs=$2 cmd=$3
  with_timeout $((secs + 5)) $CLI exec "$name" timeout -k 2 "$secs" bash -c "$cmd" </dev/null
}

sbx_stop() { with_timeout 60 $CLI stop "$1" >/dev/null 2>&1; }
sbx_restart_existing() { with_timeout 60 $CLI start "$1" </dev/null >/dev/null; }
sbx_rm() { $CLI rm -f "$1" >/dev/null 2>&1 || true; }

backend_stop() {
  case $BACKEND in
    apple) container system stop >/dev/null 2>&1 ;;
    docker) orb stop >/dev/null 2>&1 || true ;;   # OrbStack; Docker Desktop has no CLI stop
    colima) colima stop >/dev/null 2>&1 ;;
  esac
}

backend_start() {
  case $BACKEND in
    apple) container system start --disable-kernel-install </dev/null >/dev/null 2>&1 ;;
    docker) orb start >/dev/null 2>&1 ;;
    colima) colima start --vm-type vz --vz-rosetta --cpus 2 --memory 2 >/dev/null 2>&1 ;;
  esac
}
