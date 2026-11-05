---
"@psyche/cli": patch
"@psyche/desktop": patch
---

`psyche` inside the bundled Gateway and the server image works again: the systemd unit renderer now lives in the CLI, so it no longer imports desktop code that those builds leave out.
