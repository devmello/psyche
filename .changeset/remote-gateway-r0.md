---
"@psyche/gateway": patch
"@psyche/desktop": patch
"@psyche/db": patch
---

Host-bound capabilities (computer use, the Apple apps and Messages, the keychain, approval notifications, speech, dictation, Ask about my screen, OCR, the on-device model, the sandbox Mac) now go only to the Host's own Mac helper instead of the newest node that says it is a Mac helper. The Host helper is the `mac-helper` on the node socket that presents the per-launch handshake secret; a node that declares `mac-helper` any other way (a second Mac, a sandbox guest) is stored as kind `remote`, a Mac helper never pairs by owner approval, and a paired device cannot change the device family it declared at pairing (`devices.device_family`). The Host helper relays sandbox guests to a separate `run/guest.sock` instead of `node.sock`. With more than one Host helper connected nothing is routed until one leaves (or the owner pins one with `devices.hostHelperDeviceId`), and `devices.hostHelper.status` reports it. `nodes.invoke` reaches the Host helper only for its notification-permission capabilities, a Touch ID key counts only for the Host's helper, and the desktop sends the per-launch handshake secret, launches the bundled helper and asks for the first-admin bootstrap only against a loopback Gateway. No change for a single Mac.
