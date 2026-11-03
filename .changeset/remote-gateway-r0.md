---
"@psyche/gateway": patch
"@psyche/desktop": patch
---

Host-bound capabilities (computer use, the Apple apps and Messages, the keychain, approval notifications, speech, dictation, Ask about my screen, OCR, the on-device model, the sandbox Mac) now go only to the Host's own Mac helper, the node on the Gateway's Unix node socket, instead of the newest node that says it is a Mac helper. A node that declares `mac-helper` over the WebSocket is stored as kind `remote`, a Touch ID key can be registered only for the Host's helper, and with more than one Host helper connected nothing is routed until one leaves. The desktop sends the per-launch handshake secret, launches the bundled helper and asks for the first-admin bootstrap only against a loopback Gateway. No change for a single Mac.
