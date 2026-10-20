---
"@psyche/sandbox": minor
"@psyche/gateway": minor
---

Dev servers an `exec` leaves listening in a sandbox are forwarded to a host `127.0.0.1` port the runner owns and announced (`onDevServer`: host port, container port, root pid) for the browser's dev preview (I12). The Gateway's new sandbox part maps them onto the dev-preview registry.
