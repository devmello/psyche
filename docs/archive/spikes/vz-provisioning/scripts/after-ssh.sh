#!/bin/sh
# Host side, run by `vzspike provision|start --after-ssh` once the guest answers on :22.
# Installs the spike SSH key (password once via SSH_ASKPASS, no sshpass/expect), records
# facts about the guest, installs the agent from the VirtioFS payload, and probes whether
# TCC can be written from inside the guest.   after-ssh.sh <ip>   (env: VZ_USER, VZ_PASS)
set -u
ip=$1
user=${VZ_USER:-psyche}
keydir=$HOME/.psyche-spike06/ssh
mkdir -p "$keydir"
[ -f "$keydir/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -f "$keydir/id_ed25519" -C spike06
opts="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10"
askpass=$keydir/askpass.sh
printf '#!/bin/sh\necho "$VZ_PASS"\n' > "$askpass"; chmod 700 "$askpass"
t0=$(date +%s)
SSH_ASKPASS=$askpass SSH_ASKPASS_REQUIRE=force DISPLAY=:0 \
  ssh $opts -o PubkeyAuthentication=no "$user@$ip" \
  "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '$(cat "$keydir/id_ed25519.pub")' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys" </dev/null
rm -f "$askpass"
g() { ssh $opts -i "$keydir/id_ed25519" "$user@$ip" "$@"; }
echo "== guest facts"
g 'sw_vers; echo user=$(whoami) admin=$(id -Gn | tr " " "\n" | grep -cx admin); csrutil status; fdesetup status;
   echo console=$(stat -f %Su /dev/console); echo autologin=$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>&1);
   ls "/Volumes/My Shared Files" 2>&1; mount | grep -i virtio'
echo "== install agent"
g 'zsh "/Volumes/My Shared Files/payload/guest-install.sh" "/Volumes/My Shared Files/payload"'
echo "== in-guest TCC write probe (expected to fail under SIP)"
g "echo '$VZ_PASS' | sudo -S -p '' sqlite3 '/Library/Application Support/com.apple.TCC/TCC.db' 'select count(*) from access;' 2>&1;
   echo '$VZ_PASS' | sudo -S -p '' sqlite3 '/Library/Application Support/com.apple.TCC/TCC.db' \"insert into access (service,client,client_type,auth_value,auth_reason,auth_version,flags) values ('kTCCServiceAccessibility','/tmp/x',1,2,4,1,0);\" 2>&1; echo exit=\$?"
echo "after-ssh done in $(( $(date +%s) - t0 )) s"
