#!/bin/sh
# Run as root at the end of every image stage that installs packages (see Dockerfile).
set -eu
# The image PATH is the sandbox user's; root tools live in sbin.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Root gets no login shell and no password. The runner never execs as root after setup.
usermod -s /usr/sbin/nologin root
passwd -l root >/dev/null

# Apple `container` has no no-new-privileges flag, so the image must not contain any
# setuid/setgid binary that could regain privileges.
find / -xdev -perm /6000 -type f -exec chmod a-s {} +
if [ -n "$(find / -xdev -perm /6000 -type f -print -quit)" ]; then
  echo "harden.sh: setuid/setgid binaries remain" >&2
  exit 1
fi
