#!/bin/zsh
# Runs INSIDE the guest as the provisioned admin user (over SSH). Installs the spike agent
# under ~/psyche and starts it as two LaunchAgents in the GUI session (auto-login gives us one).
#   guest-install.sh <payload dir>
set -eu
src=${1:-"/Volumes/My Shared Files/payload"}
dst=$HOME/psyche
mkdir -p "$dst" ~/Library/LaunchAgents
cp "$src/node" "$src/agent.js" "$src/vsock-bridge" "$src/axcheck" "$dst/"
chmod 755 "$dst/node" "$dst/vsock-bridge" "$dst/axcheck"
uid=$(id -u)
cat > ~/Library/LaunchAgents/dev.psyche.spike.agent.plist <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.psyche.spike.agent</string>
  <key>ProgramArguments</key><array><string>$dst/node</string><string>$dst/agent.js</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$dst/agent.log</string>
</dict></plist>
PL
cat > ~/Library/LaunchAgents/dev.psyche.spike.bridge.plist <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.psyche.spike.bridge</string>
  <key>ProgramArguments</key><array><string>$dst/vsock-bridge</string><string>listen</string><string>7000</string><string>7001</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$dst/bridge.log</string>
</dict></plist>
PL
for l in agent bridge; do
  launchctl bootout gui/$uid ~/Library/LaunchAgents/dev.psyche.spike.$l.plist 2>/dev/null || true
  launchctl bootstrap gui/$uid ~/Library/LaunchAgents/dev.psyche.spike.$l.plist
done
sleep 1
launchctl print gui/$uid/dev.psyche.spike.agent | grep -E "state|pid" | head -3
echo '{"op":"ping"}' | nc -w 2 127.0.0.1 7001
