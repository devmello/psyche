#!/usr/bin/env bash
# Opt-in egress (`network: proxy`) prototype: the sandbox sits on a network with no internet
# route and reaches only the host-side allowlisting proxy (egress/proxy.py).
#   apple:  `container network create --internal` (host-only vmnet); the proxy binds to that
#           network's host gateway address; the sandbox runs with --no-dns.
#   apple socket: the sandbox keeps --network none; egress/socket-bridge.py tunnels through
#           a --publish-socket Unix socket to the proxy on 127.0.0.1 (no IP path at all).
#   docker: `docker network create --internal` cannot reach the host at all, so a relay
#           sidecar (egress/relay.py) on internal + bridge forwards to the proxy on 127.0.0.1.
# Usage: ./egress-test.sh apple [socket] | docker | colima
# Writes results/egress-<backend>[-socket].md.
BACKEND=${1:?usage: egress-test.sh apple [socket] | docker | colima}
MODE=${2:-network}
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

NET=psyche-spike-egress
NAME=psyche-spike-egress-$BACKEND
RELAY=psyche-spike-egress-relay
VOL=psyche-spike-ws-egress-$BACKEND
SUFFIX=$BACKEND; [ "$MODE" = socket ] && SUFFIX=$BACKEND-socket
OUT=$RESULTS_DIR/egress-$SUFFIX.md
PLOG=$SPIKE_DIR/.work/egress-proxy-$SUFFIX.log
SOCK=/tmp/psyche-spike-egress-$$.sock   # Unix socket paths are capped at 104 bytes on macOS
mkdir -p "$SPIKE_DIR/.work"
ALLOW=(--allow pypi.org --allow files.pythonhosted.org --allow registry.npmjs.org
       --allow github.com --allow '*.nip.io')
FAILS=0; ROWS=""
row() {
  local d; d=$(printf '%s' "$3" | tr '\n|' ' /')
  [ "$2" = FAIL ] && FAILS=$((FAILS + 1)); ROWS="$ROWS| $1 | $2 | $d |"$'\n'; log "$2 $1 - $d"
}

PROXY_PID=""; DECOY_PID=""; DIALER_PID=""; SHIM_PID=""
cleanup() {
  sbx_rm "$NAME"; [ "$BACKEND" != apple ] && sbx_rm "$RELAY"
  # SIGKILL: a `container exec` client ignores SIGTERM.
  for p in $PROXY_PID $DIALER_PID $SHIM_PID; do kill -KILL "$p" 2>/dev/null; done
  rm -f "$SOCK"
  [ -n "$DECOY_PID" ] && kill "$DECOY_PID" 2>/dev/null
  $CLI network rm "$NET" >/dev/null 2>&1; vol_rm "$VOL"
}
trap cleanup EXIT
cleanup
vol_create "$VOL" || exit 1
$CLI network create --internal "$NET" >/dev/null || { echo "network create failed"; exit 1; }

# A decoy host service bound to all interfaces, to see what else the sandbox can reach.
python3 -m http.server 18081 --bind 0.0.0.0 >/dev/null 2>&1 & DECOY_PID=$!

case $BACKEND-$MODE in
  apple-socket)
    PROXY_HOST=127.0.0.1   # inside the sandbox: the shim
    proxy_env=(-e "HTTP_PROXY=http://127.0.0.1:3128" -e "HTTPS_PROXY=http://127.0.0.1:3128"
               -e "http_proxy=http://127.0.0.1:3128" -e "https_proxy=http://127.0.0.1:3128"
               -e "ALL_PROXY=socks5h://127.0.0.1:1080")
    sbx_start "$NAME" "$VOL" socket --init --publish-socket "$SOCK:/run/psyche/egress.sock" "${proxy_env[@]}" \
      || { row start FAIL "sandbox start"; exit 1; }
    python3 "$SPIKE_DIR/egress/proxy.py" --bind 127.0.0.1 "${ALLOW[@]}" 2> "$PLOG" & PROXY_PID=$!
    $CLI exec "$NAME" python3 /usr/local/lib/psyche/socket-bridge.py shim /run/psyche/egress.sock \
      </dev/null >/dev/null 2>&1 & SHIM_PID=$!
    sleep 1
    python3 "$SPIKE_DIR/egress/socket-bridge.py" dialer "$SOCK" --pool 8 >/dev/null 2>&1 & DIALER_PID=$!
    DECOY_URL=http://192.168.64.1:18081/
    ;;
  apple-*)
    subnet=$(container network ls | awk -v n="$NET" '$1 == n {print $2}')
    PROXY_HOST=$(echo "$subnet" | awk -F'[./]' '{printf "%s.%s.%s.1", $1, $2, $3}')
    proxy_env=(-e "HTTP_PROXY=http://$PROXY_HOST:3128" -e "HTTPS_PROXY=http://$PROXY_HOST:3128"
               -e "http_proxy=http://$PROXY_HOST:3128" -e "https_proxy=http://$PROXY_HOST:3128"
               -e "ALL_PROXY=socks5h://$PROXY_HOST:1080")
    sbx_start "$NAME" "$VOL" "$NET" --init "${proxy_env[@]}" || { row start FAIL "sandbox start"; exit 1; }
    # The host side of the vmnet bridge exists only once a container is attached, so bind now.
    for i in 1 2 3 4 5 6 7 8 9 10; do
      ifconfig | grep -q "inet $PROXY_HOST " && break; sleep 0.5
    done
    python3 "$SPIKE_DIR/egress/proxy.py" --bind "$PROXY_HOST" "${ALLOW[@]}" 2> "$PLOG" & PROXY_PID=$!
    DECOY_URL=http://$PROXY_HOST:18081/
    ;;
  *)
    python3 "$SPIKE_DIR/egress/proxy.py" --bind 127.0.0.1 "${ALLOW[@]}" 2> "$PLOG" & PROXY_PID=$!
    hostname=host.docker.internal; [ "$BACKEND" = colima ] && hostname=host.lima.internal
    with_timeout 60 docker run -d --name "$RELAY" --network bridge --read-only --cap-drop ALL \
      --security-opt no-new-privileges --user 1000:1000 --memory 64m --pids-limit 32 \
      --mount "type=bind,source=$SPIKE_DIR/egress/relay.py,target=/relay.py,readonly" \
      "$IMAGE" python3 /relay.py "3128=$hostname:3128" "1080=$hostname:1080" </dev/null >/dev/null
    docker network connect "$NET" "$RELAY"
    PROXY_HOST=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$RELAY")
    proxy_env=(-e "HTTP_PROXY=http://$PROXY_HOST:3128" -e "HTTPS_PROXY=http://$PROXY_HOST:3128"
               -e "http_proxy=http://$PROXY_HOST:3128" -e "https_proxy=http://$PROXY_HOST:3128"
               -e "ALL_PROXY=socks5h://$PROXY_HOST:1080")
    sbx_start "$NAME" "$VOL" "$NET" --init "${proxy_env[@]}" || { row start FAIL "sandbox start"; exit 1; }
    # host.docker.internal does not resolve without DNS; try the host addresses directly.
    DECOY_URL=http://0.250.250.254:18081/; [ "$BACKEND" = colima ] && DECOY_URL=http://192.168.5.2:18081/
    ;;
esac
sleep 1
row "setup" INFO "proxy at $PROXY_HOST (HTTP 3128, SOCKS5 1080)"

code() { sbx_exec "$NAME" 25 "curl -sS -m 15 -o /dev/null -w '%{http_code}' $1 2>&1 | tail -c 200"; }
expect() { # expect <check> <want-regex> <curl args>
  local got; got=$(code "$3")
  if echo "$got" | grep -Eq "$2"; then row "$1" PASS "$got"; else row "$1" FAIL "$got"; fi
}

expect "allowlisted https via HTTP proxy (pypi.org)" '^200$' 'https://pypi.org/simple/pip/'
expect "allowlisted https via SOCKS5 (socks5h)" '^200$' "--socks5-hostname $PROXY_HOST:1080 https://pypi.org/simple/pip/"
expect "non-allowlisted host denied (example.com)" '403|CONNECT' 'https://example.com/'
expect "non-allowlisted host denied over SOCKS5" '000|not allowed|SOCKS' "--socks5-hostname $PROXY_HOST:1080 https://example.com/"
expect "plain http to non-allowlisted host denied" '^403$' 'http://example.com/'
expect "metadata IP via proxy denied (169.254.169.254)" '403|CONNECT' 'http://169.254.169.254/latest/meta-data/'
expect "allowlisted name resolving to loopback denied (127.0.0.1.nip.io)" '403|CONNECT' 'https://127.0.0.1.nip.io/'
expect "non-allowed port denied (pypi.org:22)" '403|CONNECT' 'https://pypi.org:22/'
expect "direct https without proxy fails" '^000|resolve|connect|timed out' "--noproxy '*' https://pypi.org/"
expect "direct IP without proxy fails (1.1.1.1)" '^000|connect|timed out' "--noproxy '*' http://1.1.1.1/"

dns=$(sbx_exec "$NAME" 15 'timeout 5 getent hosts example.com && echo RESOLVED || echo "getent failed (exit $?)"')
row "sandbox DNS for external names" "$(echo "$dns" | grep -q RESOLVED && echo FAIL || echo PASS)" \
  "$(echo "$dns" | tail -1)"

npmv=$(sbx_exec "$NAME" 60 'cd /tmp && npm view left-pad version --no-update-notifier --cache /tmp/npm 2>&1 | tail -1')
row "npm through the proxy (registry.npmjs.org)" "$(echo "$npmv" | grep -Eq '^[0-9]+\.[0-9]+' && echo PASS || echo FAIL)" "left-pad $npmv"
gitv=$(sbx_exec "$NAME" 60 'git ls-remote https://github.com/octocat/Hello-World HEAD 2>&1 | tail -2 | cut -c1-120')
row "git over https through the proxy (github.com)" "$(echo "$gitv" | grep -Eq '^[0-9a-f]{12}' && echo PASS || echo FAIL)" "$gitv"

decoy=$(code "--noproxy '*' $DECOY_URL")
row "other host services on 0.0.0.0 reachable?" "$([ "$decoy" = 200 ] && echo RISK || echo PASS)" \
  "$DECOY_URL -> $decoy"

allowed=$(grep -c '"decision": "allow"' "$PLOG"); denied=$(grep -c '"decision": "deny"' "$PLOG")
row "proxy log" INFO "$allowed allowed, $denied denied ($(grep '"deny"' "$PLOG" | sed -E 's/.*"host": "([^"]*)".*"reason": "([^"]*)".*/\1: \2/' | sort -u | tr '\n' ';'))"

{
  echo "# Egress proxy check: $BACKEND ($(date '+%Y-%m-%d %H:%M'))"
  echo
  echo "Allowlist: ${ALLOW[*]}"
  echo
  echo "| check | result | detail |"
  echo "|---|---|---|"
  printf '%s' "$ROWS"
  echo
  echo "Failures: $FAILS"
} > "$OUT"
cat "$OUT"
exit $((FAILS > 0))
