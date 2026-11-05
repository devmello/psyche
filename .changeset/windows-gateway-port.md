---
"@psyche/protocol": minor
"@psyche/db": minor
"@psyche/gateway": minor
"@psyche/node": minor
---

Windows support for the Gateway and the headless node. A Windows helper (`win-helper`) on the local node transport with the handshake secret is the Host's own helper, exactly like the Mac helper. On Windows the node transport and the browser bridge are named pipes (`\\.\pipe\psyche-node-<hash>`, `\\.\pipe\psyche-bridge-<hash>`) recorded in `$PSYCHE_HOME/run` as before, `$PSYCHE_HOME` is limited to the current user and SYSTEM, and Windows Hello RSA presence keys verify approvals like Touch ID keys. The protocol gains the `windows` platform and the `win-helper` node kind.
