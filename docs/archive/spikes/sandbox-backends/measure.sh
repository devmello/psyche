#!/usr/bin/env bash
# Startup, round-trip, file-share and memory measurements for one backend.
# Usage: ./measure.sh apple|docker|colima [--cold N]
#   --cold N  also stop and restart the backend N times to time a cold start (disruptive:
#             stops every container on that backend).
# Writes results/measure-<backend>.md.
BACKEND=${1:?usage: measure.sh apple|docker|colima [--cold N]}
COLD=0; [ "${2:-}" = --cold ] && COLD=${3:-3}
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

OUT=$RESULTS_DIR/measure-$BACKEND.md
WORK=$SPIKE_DIR/.work/$BACKEND   # host-side share for the bind-mount throughput test
VOL=psyche-spike-ws-measure-$BACKEND
NAME=psyche-spike-m-$BACKEND
WARM_RUNS=${WARM_RUNS:-10}
LINES=""

# stats <numbers...> -> "median X ms (min A, p90 B, n N)"
stats() {
  printf '%s\n' "$@" | sort -n | awk '{a[NR]=$1} END {
    p90 = a[int((NR * 9 + 9) / 10)]; if (p90 == "") p90 = a[NR];
    m = (NR % 2) ? a[(NR + 1) / 2] : (a[NR / 2] + a[NR / 2 + 1]) / 2;
    printf "median %d ms (min %d, p90 %d, n %d)", m, a[1], p90, NR }'
}
add() { LINES="$LINES| $1 | $2 |"$'\n'; log "$1: $2"; }

cleanup() { sbx_rm "$NAME"; for i in $(seq 1 "$WARM_RUNS"); do sbx_rm "$NAME-w$i"; done; }
trap 'cleanup; vol_rm "$VOL"' EXIT
cleanup; vol_rm "$VOL"
vol_create "$VOL" || exit 1

# --- cold start: backend stopped -> first command done in a fresh container ---------------
if [ "$COLD" -gt 0 ]; then
  cold=(); boot=()
  for i in $(seq 1 "$COLD"); do
    backend_stop; sleep 3
    t0=$(now_ms); backend_start; t1=$(now_ms)
    sbx_start "$NAME" "$VOL" none --init && sbx_exec "$NAME" 10 true >/dev/null
    t2=$(now_ms); sbx_rm "$NAME"
    boot+=($((t1 - t0))); cold+=($((t2 - t0)))
  done
  add "cold: backend start" "$(stats "${boot[@]}")"
  add "cold: backend start + first container + first command" "$(stats "${cold[@]}")"
fi

# --- warm start: backend running, new container -> first command done --------------------
# The first iteration also pays any page-cache warm-up for the image; keep it in the sample.
warm=(); oneshot=()
for i in $(seq 1 "$WARM_RUNS"); do
  t0=$(now_ms)
  sbx_start "$NAME-w$i" "$VOL" none --init && sbx_exec "$NAME-w$i" 10 true >/dev/null
  warm+=($(( $(now_ms) - t0 )))
  sbx_rm "$NAME-w$i"
done
add "warm: run -d + first exec (new container)" "$(stats "${warm[@]}")"

read_flags none
for i in $(seq 1 "$WARM_RUNS"); do
  t0=$(now_ms)
  with_timeout 60 $CLI run --rm "${FLAGS[@]}" -v "$VOL:/workspace" --init "$IMAGE" true </dev/null >/dev/null
  oneshot+=($(( $(now_ms) - t0 )))
done
add "warm: one-shot run --rm true" "$(stats "${oneshot[@]}")"

# --- restart of an existing stopped container (with --init so SIGTERM stops PID 1) --------
sbx_start "$NAME" "$VOL" none --init
restart=(); stopt=()
for i in 1 2 3 4 5; do
  t0=$(now_ms); sbx_stop "$NAME"; t1=$(now_ms)
  sbx_restart_existing "$NAME" && sbx_exec "$NAME" 10 true >/dev/null
  stopt+=($((t1 - t0))); restart+=($(( $(now_ms) - t1 )))
done
add "stop (with --init)" "$(stats "${stopt[@]}")"
add "restart: start stopped container + first exec" "$(stats "${restart[@]}")"

# --- command round trip -------------------------------------------------------------------
raw=(); wrapped=()
for i in $(seq 1 20); do
  t0=$(now_ms); $CLI exec "$NAME" true </dev/null; raw+=($(( $(now_ms) - t0 )))
  t0=$(now_ms); sbx_exec "$NAME" 30 true; wrapped+=($(( $(now_ms) - t0 )))
done
add "exec round trip (exec true)" "$(stats "${raw[@]}")"
add "exec round trip via runner wrapper (timeout + bash -c)" "$(stats "${wrapped[@]}")"

# --- file-share throughput, 200 MB ------------------------------------------------------
mkdir -p "$WORK/in" "$WORK/out"; chmod 777 "$WORK/out"
[ -f "$WORK/in/blob" ] || head -c 209715200 /dev/urandom > "$WORK/in/blob"
rm -f "$WORK/out/"*
mbps() { awk -v ms="$1" 'BEGIN { printf "%.0f MB/s (%d ms)", 200 / (ms / 1000), ms }'; }

sbx_rm "$NAME"
read_flags none
with_timeout 120 $CLI run -d --name "$NAME" "${FLAGS[@]}" --init -v "$VOL:/workspace" \
  --mount "type=bind,source=$WORK/in,target=/share-in,readonly" \
  --mount "type=bind,source=$WORK/out,target=/share-out" \
  "$IMAGE" sleep infinity </dev/null >/dev/null || { log "bind-mount start failed"; }

sbx_exec "$NAME" 30 'rm -f /workspace/blob*' >/dev/null
t0=$(now_ms); with_timeout 300 $CLI cp "$WORK/in/blob" "$NAME:/workspace/blob-cp" </dev/null >/dev/null 2>&1; rc=$?
d=$(( $(now_ms) - t0 ))
ok=$(sbx_exec "$NAME" 30 'stat -c %s /workspace/blob-cp 2>/dev/null')
add "host -> workspace volume via \`$CLI cp\`" "$([ "$ok" = 209715200 ] && mbps $d || echo "failed (rc $rc, size ${ok:-none})")"

t0=$(now_ms)
with_timeout 300 $CLI exec -i "$NAME" bash -c 'cat > /workspace/blob-stdin' < "$WORK/in/blob"; rc=$?
d=$(( $(now_ms) - t0 ))
ok=$(sbx_exec "$NAME" 30 'stat -c %s /workspace/blob-stdin 2>/dev/null')
add "host -> workspace volume via \`exec -i\` stdin stream" "$([ "$ok" = 209715200 ] && mbps $d || echo "failed (rc $rc, size ${ok:-none})")"

t0=$(now_ms); sbx_exec "$NAME" 120 'cp /share-in/blob /workspace/blob-in && sync'; rc=$?
add "host -> workspace via read-only bind mount (cp inside)" "$([ $rc = 0 ] && mbps $(( $(now_ms) - t0 )) || echo "failed rc $rc")"

t0=$(now_ms); sbx_exec "$NAME" 120 'cp /workspace/blob-in /share-out/blob && sync'; rc=$?
d=$(( $(now_ms) - t0 )); hsize=$(stat -f %z "$WORK/out/blob" 2>/dev/null)
add "workspace -> host via rw bind mount (cp inside)" "$([ $rc = 0 ] && [ "$hsize" = 209715200 ] && mbps $d || echo "failed rc $rc, host size ${hsize:-none}")"
owner=$(stat -f '%Su:%Sg' "$WORK/out/blob" 2>/dev/null)
add "owner on host of a file written by UID 1000" "${owner:-n/a}"

t0=$(now_ms); sbx_exec "$NAME" 120 'cp /workspace/blob-in /workspace/blob-dup && sync'; rc=$?
add "within workspace volume (cp inside, baseline)" "$([ $rc = 0 ] && mbps $(( $(now_ms) - t0 )) || echo "failed rc $rc")"
sbx_exec "$NAME" 30 'rm -f /workspace/blob*' >/dev/null

# --- memory overhead ----------------------------------------------------------------------
# Apple: each container is its own VM, whose guest RAM shows up in the VirtualMachine XPC
# process's phys_footprint. OrbStack maps guest RAM so that it shows in RSS, not footprint.
fp_mb() { footprint -p "$1" 2>/dev/null | sed -n 2p | awk '{for(i=1;i<=NF;i++) if($i=="Footprint:"){v=$(i+1);u=$(i+2)}} END {if(u=="KB")v/=1024; if(u=="GB")v*=1024; printf "%d", v}'; }
rss_mb() { ps -o rss= -p "$1" | awk '{printf "%d", $1 / 1024}'; }
case $BACKEND in
  apple) vm_pids() { pgrep -f com.apple.Virtualization.VirtualMachine | sort; }; mem_mb() { fp_mb "$1"; }; METRIC=footprint ;;
  docker) vm_pids() { pgrep -f "OrbStack Helper" | sort; }; mem_mb() { rss_mb "$1"; }; METRIC=RSS ;;
  colima) vm_pids() { pgrep -f "limactl.*hostagent" | sort; }; mem_mb() { rss_mb "$1"; }; METRIC=RSS ;;
esac
HOLD='python3 -c "import time; b = bytearray(400 * 1024 * 1024); b[::4096] = b\"x\" * len(b[::4096]); time.sleep(12)"'
FREE_WAIT=${FREE_WAIT:-20}

sbx_rm "$NAME"; sleep 3
before=$(vm_pids)
[ "$BACKEND" != apple ] && base=$(mem_mb "$(echo "$before" | head -1)")
sbx_start "$NAME" "$VOL" none --init; sleep 3
if [ "$BACKEND" = apple ]; then
  pid=$(comm -13 <(echo "$before") <(vm_pids) | head -1)   # the VM that just appeared
else
  pid=$(echo "$before" | head -1)
fi
idle=$(mem_mb "$pid")
sbx_exec "$NAME" 30 "$HOLD" >/dev/null & sleep 8
held=$(mem_mb "$pid"); wait
sleep "$FREE_WAIT"; freed=$(mem_mb "$pid")
[ "$BACKEND" != apple ] && add "memory ($METRIC): backend VM, no container" "${base} MB (pid $pid)"
add "memory ($METRIC): $([ "$BACKEND" = apple ] && echo "per-container VM" || echo "backend VM with one container"), idle" "${idle} MB"
add "memory ($METRIC): while the container holds 400 MB" "${held} MB"
add "memory ($METRIC): ${FREE_WAIT} s after the 400 MB was freed" "${freed} MB"
if [ "$BACKEND" = apple ]; then
  add "memory (footprint): host services, shared by all containers" \
    "$(for p in $(pgrep -f 'container-apiserver|container-core-images|container-network-vmnet|machine-apiserver|container-runtime-linux'); do fp_mb "$p"; echo; done | awk '{s+=$1} END {print s}') MB"
fi

{
  echo "# Measurements: $BACKEND ($(date '+%Y-%m-%d %H:%M'))"
  echo
  echo "Host: $(sw_vers -productVersion) on $(sysctl -n machdep.cpu.brand_string), $(( $(sysctl -n hw.memsize) / 1073741824 )) GB."
  case $BACKEND in
    apple) echo "Backend: $(container --version)." ;;
    *) echo "Backend: Docker $(docker version --format '{{.Server.Version}}') on $(docker info --format '{{.OperatingSystem}}')." ;;
  esac
  echo
  echo "| metric | value |"
  echo "|---|---|"
  printf '%s' "$LINES"
} > "$OUT"
cat "$OUT"
