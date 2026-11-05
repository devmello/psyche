---
"@psyche/desktop": minor
---

Linux packaging and updates (work in progress): the signed update manifest can carry AppImage, deb and rpm artifacts, selected by platform, architecture and install kind; the Linux apply step (AppImage verified rename, deb/rpm through `pkexec`) with rollback of the previous artifact; the one-time system setup script, desktop file and icons.
