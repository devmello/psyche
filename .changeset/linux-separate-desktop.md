---
"@psyche/sandbox": minor
"@psyche/gateway": minor
"@psyche/ui": minor
---

Linux: add the separate desktop, a private desktop in a rootless Podman container with its own apps and files. It has no network and no folders unless you allow them for a task, pairs its helper over a socket only that container can reach, and is removed when the task ends.
