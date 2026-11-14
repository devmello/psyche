---
"@psyche/desktop": minor
---

Psyche now builds for Linux as a deb, an rpm and an AppImage (x86_64 and aarch64), with the Gateway bundled. Updates work on Linux: the signed manifest lists the three formats, a copy takes the one it was installed from, and "Restart to update" replaces the AppImage or runs the package manager after one admin prompt. The previous version is kept so you can go back.
