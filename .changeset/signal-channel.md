---
"@psyche/channels": minor
"@psyche/gateway": minor
---

Signal channel adapter (N7) over the owner's own signal-cli JSON-RPC daemon socket (`node:net`, no SDK). It refuses account-changing methods, checks the socket's ownership and permissions before connecting, reconnects with back-off up to 60 s, maps DMs, groups, quotes and attachments, and answers approvals with 👍 / 👎 reactions only. Gateway wiring comes from `PSYCHE_SIGNAL_SOCKET` + `PSYCHE_SIGNAL_NUMBER`.
