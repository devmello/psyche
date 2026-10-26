---
"@psyche/scheduler": minor
"@psyche/proactive": minor
"@psyche/db": minor
"@psyche/gateway": minor
---

Event triggers (#670 W3): `kind: "event"` automations run on `publishEvent` with dedupe by source id, debounce coalescing, a daily run budget, a restart-safe queue, taint by source and durable cursors; Upcoming shows them and run-now replays the last events. A new-mail poller publishes `mail.received` from Apple Mail and Gmail every 10 minutes in active hours, only when something listens. The scheduler tables are rebuilt to allow the new kind without losing history.
