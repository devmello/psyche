#!/bin/sh
# Runs the spike's checks against a running guest: vsock both ways, TCC state, VirtioFS
# read-only enforcement, a custom-tag mount, a live share change.   verify.sh <bundle>
# (env: VZ_USER, VZ_PASS; the spike SSH key must already be installed by after-ssh.sh)
set -u
B=$1
V=$(cd "$(dirname "$0")/.." && pwd)/.build/release/vzspike
user=${VZ_USER:-psyche}
ip=$($V status "$B" | sed -n 's/.*ip=\([0-9.]*\).*/\1/p')
opts="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10"
g() { ssh $opts -i "$HOME/.psyche-spike06/ssh/id_ed25519" "$user@$ip" "$@"; }
echo "== guest $ip"
echo "== host -> guest vsock (port 7000 -> bridge -> node agent)"
for i in 1 2 3; do $V vsock-echo "$B" 7000 '{"op":"ping"}'; done
$V vsock-echo "$B" 7000 '{"op":"tcc"}'
echo "== guest -> host vsock (CID 2, port 5000)"
g 'printf "hello-from-guest\n" | (~/psyche/vsock-bridge connect 2 5000 & p=$!; sleep 2; kill $p 2>/dev/null)'
echo "== automount share (read-only)"
g 'ls -la "/Volumes/My Shared Files/"; touch "/Volumes/My Shared Files/payload/x" 2>&1; mount | grep -i virtiofs'
echo "== agent write attempt into the read-only share"
$V vsock-echo "$B" 7000 '{"op":"write","path":"/Volumes/My Shared Files/payload/agent-wrote"}'
echo "== custom tag 'psyche' at /Volumes/Psyche Shares (needs root in the guest)"
g "echo '$VZ_PASS' | sudo -S -p '' mkdir -p '/Volumes/Psyche Shares' && echo '$VZ_PASS' | sudo -S -p '' mount_virtiofs psyche '/Volumes/Psyche Shares' 2>&1; ls -la '/Volumes/Psyche Shares'"
mkdir -p "$HOME/.psyche-spike06/live-share" && date > "$HOME/.psyche-spike06/live-share/added-at-runtime.txt"
echo "== live share change: add 'live' (rw) to tag psyche"
$V share "$B" psyche live "$HOME/.psyche-spike06/live-share" rw
g "ls -la '/Volumes/Psyche Shares' '/Volumes/Psyche Shares/live' 2>&1; echo guest-wrote > '/Volumes/Psyche Shares/live/from-guest.txt' && echo rw-write-ok"
ls -la "$HOME/.psyche-spike06/live-share"
echo "== remove it again"
$V share "$B" psyche live "$HOME/.psyche-spike06/live-share" ro >/dev/null
echo "(ro now)"; g "echo again > '/Volumes/Psyche Shares/live/again.txt' 2>&1 || true"
echo "== host memory of the VM process"
for p in $(pgrep -f com.apple.Virtualization.VirtualMachine); do
  ps -o pid=,rss= -p $p | awk '{printf "pid %s rss %.0f MB\n", $1, $2/1024}'
  footprint -p $p 2>/dev/null | grep -E "phys_footprint:|Footprint" | head -2
done
