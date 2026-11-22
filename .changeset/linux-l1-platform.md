---
"@psyche/desktop": minor
"@psyche/cli": patch
---

Linux desktop foundation: Psyche runs its Gateway as a `systemd --user` service, with Linux autostart, tray fallback, keyring guard, real-Chrome paths and an uninstall sheet. The CLI now writes its systemd unit from the same shared renderer (server output unchanged).
