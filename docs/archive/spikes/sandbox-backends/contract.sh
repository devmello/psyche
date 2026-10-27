#!/usr/bin/env bash
# Functional check of the per-task sandbox contract (docs/02-architecture.md section 9) on one
# backend. Usage: ./contract.sh apple|docker|colima [socket]
#   socket (apple only): the profile used with the --publish-socket egress bridge.
# Writes results/contract-<backend>[-socket].md and exits non-zero if any check fails.
BACKEND=${1:?usage: contract.sh apple|docker|colima [socket]}
PROFILE=${2:-none}
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

NAME=psyche-spike-contract-$BACKEND
VOL=psyche-spike-ws-contract-$BACKEND
OUT=$RESULTS_DIR/contract-$BACKEND$([ "$PROFILE" = socket ] && echo -socket).md
FAILS=0
ROWS=""

row() { # row <check> <PASS|FAIL|INFO> <detail>
  [ "$2" = FAIL ] && FAILS=$((FAILS + 1))
  local d; d=$(printf '%s' "$3" | tr '\n|' ' /')
  ROWS="$ROWS| $1 | $2 | $d |"$'\n'
  log "$2 $1 - $d"
}

cleanup() { sbx_rm "$NAME"; vol_rm "$VOL"; }
trap cleanup EXIT
cleanup

vol_create "$VOL" || { row "volume create" FAIL "could not create $VOL"; exit 1; }

t0=$(now_ms)
if sbx_start "$NAME" "$VOL" "$PROFILE"; then
  row "start (profile $PROFILE)" PASS "$(( $(now_ms) - t0 )) ms to detached"
else
  row "start" FAIL "run -d failed"; exit 1
fi

# Identity and hardening as seen from inside.
id_out=$(sbx_exec "$NAME" 10 'id -u; id -g; grep CapEff /proc/self/status | awk "{print \$2}"')
uid=$(echo "$id_out" | sed -n 1p); capeff=$(echo "$id_out" | sed -n 3p)
[ "$uid" = 1000 ] && row "runs as UID 1000" PASS "uid=$uid gid=$(echo "$id_out" | sed -n 2p)" \
  || row "runs as UID 1000" FAIL "uid=$uid"
[ "$capeff" = 0000000000000000 ] && row "all capabilities dropped" PASS "CapEff=$capeff" \
  || row "all capabilities dropped" FAIL "CapEff=$capeff"
suid=$(sbx_exec "$NAME" 20 'find / -xdev -perm /6000 -type f 2>/dev/null | wc -l' | tr -d ' ')
row "no setuid/setgid binaries" "$([ "$suid" = 0 ] && echo PASS || echo FAIL)" "$suid found"

# 20 bounded commands, sequentially, through the exec channel.
CMDS=(
  'echo hello'
  'python3 -c "print(sum(range(10**6)))"'
  'node -e "console.log(process.version)"'
  'git --version'
  'jq --version'
  'rg --version | head -1'
  'git init -q /workspace/repo && echo ok'
  'cd /workspace/repo && printf "a\nb\n" > f.txt && git add f.txt && echo ok'
  'cd /workspace/repo && git -c user.email=s@x -c user.name=s commit -qm init && git log --oneline | wc -l'
  'echo "{\"a\":[1,2,3]}" | jq ".a | add"'
  'rg -c b /workspace/repo/f.txt'
  'seq 1 100000 | sort -rn | head -1'
  'python3 -c "import json,hashlib;print(hashlib.sha256(b\"x\"*10**6).hexdigest()[:8])"'
  'node -e "require(\"fs\").writeFileSync(\"/workspace/n.json\", JSON.stringify({ok:1}))" && cat /workspace/n.json'
  'mkdir -p /workspace/d && for i in $(seq 1 50); do echo $i > /workspace/d/$i; done && ls /workspace/d | wc -l'
  'du -sh /workspace | cut -f1'
  'head -c 1000000 /dev/urandom | base64 | wc -c'
  'cat /proc/loadavg'
  'printf "%s\n" "$HOME" "$PWD"'
  'true'
)
ok=0; t0=$(now_ms); slowest=0
for c in "${CMDS[@]}"; do
  s=$(now_ms)
  if sbx_exec "$NAME" 30 "$c" >/dev/null 2>&1; then ok=$((ok + 1)); fi
  d=$(( $(now_ms) - s )); [ $d -gt $slowest ] && slowest=$d
done
total=$(( $(now_ms) - t0 ))
row "20 bounded commands" "$([ $ok = 20 ] && echo PASS || echo FAIL)" \
  "$ok/20 exit 0; total ${total} ms, mean $((total / 20)) ms, slowest ${slowest} ms"

# Large output survives the exec channel (the runner caps at 128 KB on the host side).
bytes=$(sbx_exec "$NAME" 10 'head -c 1048576 /dev/zero' | wc -c | tr -d ' ')
row "1 MiB stdout through exec" "$([ "$bytes" = 1048576 ] && echo PASS || echo FAIL)" "$bytes bytes"

# Bound enforcement: a 30 s command with a 3 s bound must end with 124 in about 3 s.
s=$(now_ms); sbx_exec "$NAME" 3 'sleep 30' >/dev/null 2>&1; rc=$?; d=$(( $(now_ms) - s ))
row "timeout bound (3 s)" "$([ $rc = 124 ] && [ $d -lt 6000 ] && echo PASS || echo FAIL)" "exit $rc after $d ms"

# Interrupt a running command. First: does killing the host-side exec client stop it?
client_probe() { # client_probe <signal>: start a 301 s command, signal the host client, report
  $CLI exec "$NAME" bash -c 'sleep 301; : psyche-marker-a' </dev/null >/dev/null 2>&1 &
  local cpid=$! client left
  sleep 2; kill "-$1" $cpid 2>/dev/null; sleep 2
  kill -0 $cpid 2>/dev/null && client="client still running" || client="client exited"
  left=$(sbx_exec "$NAME" 5 'pgrep -f "sleep 30[1]" | wc -l' | tr -d ' ')
  [ "$left" = 0 ] && left="process stopped" || left="process KEEPS RUNNING"
  sbx_exec "$NAME" 5 'pkill -f "sleep 30[1]"; true' >/dev/null 2>&1
  kill -KILL $cpid 2>/dev/null; wait $cpid 2>/dev/null
  echo "SIG$1: $client, $left"
}
row "interrupt: signal host exec client" INFO "$(client_probe TERM); $(client_probe KILL)"

# Then the runner's real interrupt: each command runs in its own session (setsid) with a pid
# file; interrupt = kill the whole process group from a second exec.
$CLI exec "$NAME" setsid -w bash -c 'echo $$ > /tmp/cmd-7.pid; sleep 300 & sleep 300 & wait' \
  </dev/null >/dev/null 2>&1 &
cpid=$!; sleep 2
s=$(now_ms)
sbx_exec "$NAME" 5 'kill -TERM -- -$(cat /tmp/cmd-7.pid)' >/dev/null 2>&1
wait $cpid 2>/dev/null; rc=$?; d=$(( $(now_ms) - s ))
left=$(sbx_exec "$NAME" 5 'pgrep -f "sleep 30[0]" | wc -l' | tr -d ' ')
row "interrupt: kill process group via exec" "$([ "$left" = 0 ] && echo PASS || echo FAIL)" \
  "client exit $rc, $d ms to stop, $left sleep processes left"

# Files persist across a container stop/start.
sum=$(sbx_exec "$NAME" 20 'head -c 5000000 /dev/urandom > /workspace/persist.bin && sha256sum /workspace/persist.bin | cut -c1-16')
s=$(now_ms); sbx_stop "$NAME"; sbx_restart_existing "$NAME"
after=$(sbx_exec "$NAME" 20 'sha256sum /workspace/persist.bin | cut -c1-16'); d=$(( $(now_ms) - s ))
row "files persist across restart" "$([ -n "$sum" ] && [ "$sum" = "$after" ] && echo PASS || echo FAIL)" \
  "sha $sum -> $after; stop+start+exec $d ms"
tmpafter=$(sbx_exec "$NAME" 5 'ls /tmp | wc -l' | tr -d ' ')
row "tmp is wiped on restart" INFO "$tmpafter entries in /tmp after restart"

# Network must be unreachable.
net=$(sbx_exec "$NAME" 20 '
  ls /sys/class/net | tr "\n" " "; echo
  curl -sS -m 5 -o /dev/null https://example.com 2>&1 | head -1
  curl -sS -m 5 -o /dev/null http://1.1.1.1 2>&1 | head -1
  getent hosts example.com >/dev/null && echo dns-ok || echo dns-fail')
ifaces=$(echo "$net" | sed -n 1p)
if echo "$net" | grep -q dns-ok || [ "$(echo "$ifaces" | tr -d ' ')" != lo ]; then
  row "network none" FAIL "$(echo "$net" | tr '\n' ';')"
else
  row "network none" PASS "interfaces: $ifaces; curl and DNS fail"
fi

# Writes outside /workspace must fail (except the capped /tmp tmpfs).
w=$(sbx_exec "$NAME" 20 '
  for p in /etc/x /usr/local/bin/x /x /var/x /home/x /opt/x; do
    (echo x > $p) 2>/dev/null && echo "WROTE $p"
  done; echo checked')
row "rootfs writes outside /workspace fail" "$(echo "$w" | grep -q WROTE && echo FAIL || echo PASS)" \
  "$(echo "$w" | tr '\n' ' ')"
t=$(sbx_exec "$NAME" 20 'head -c 80000000 /dev/zero > /tmp/big 2>/dev/null; du -m /tmp/big | cut -f1; rm -f /tmp/big')
row "tmp capped at 64 MB" "$([ "${t:-999}" -le 64 ] && echo PASS || echo FAIL)" "an 80 MB write stopped at ${t} MB"

# Resource caps.
sbx_exec "$NAME" 30 'python3 -c "b = bytearray(700 * 1024 * 1024); print(len(b))"' >/dev/null 2>&1; rc=$?
row "memory cap 512 MB" "$([ $rc = 137 ] && echo PASS || echo FAIL)" "700 MB allocation exit $rc (137 = OOM kill)"
p=$(sbx_exec "$NAME" 30 'n=0; for i in $(seq 1 200); do sleep 3 2>/dev/null & [ $? = 0 ] && n=$((n+1)); done 2>/dev/null; jobs -r | wc -l; wait' 2>/dev/null | head -1 | tr -d ' ')
row "pids cap 128" "$([ "${p:-200}" -lt 130 ] && echo PASS || echo FAIL)" "$p of 200 background processes started"
c=$(sbx_exec "$NAME" 10 'cat /sys/fs/cgroup/cpu.max 2>/dev/null; nproc')
row "cpu cap 1" INFO "$(echo "$c" | tr '\n' ' ')(cpu.max quota/period, nproc)"

{
  echo "# Contract check: $BACKEND, profile $PROFILE ($(date '+%Y-%m-%d %H:%M'))"
  echo
  echo "| check | result | detail |"
  echo "|---|---|---|"
  printf '%s' "$ROWS"
  echo
  echo "Failures: $FAILS"
} > "$OUT"
cat "$OUT"
exit $((FAILS > 0))
