---
"@psyche/protocol": minor
"@psyche/gateway": minor
"@psyche/db": minor
"@psyche/cli": minor
"@psyche/desktop": minor
"@psyche/tasks": minor
"@psyche/ui": minor
---

Hardening of the update foundation after review. The pre-update snapshot now keeps 2 (older ones go only after 14 days, only after a good start, never the newest), sorts by sequence, reuses its snapshot after an interrupted start, includes the key files, syncs to disk, and restores crash-safely (a marker is finished at the next boot). An unreadable database is snapshotted, not skipped. A failed update is retried after a pause for machine errors and only on request for broken migrations (Retry on the start-up screen, `psyche migrate --retry`); the desktop waits longer while a snapshot or migration is visibly running. Typos in `config.json` security sections stay fatal while truly unknown keys are only warned about (in `psyche doctor` and Settings). Channel messages that arrive while an update is being prepared are held, not dropped. The desktop restarts a stale Gateway only after its identity is verified, only one it started, by reloading the plist, and after asking it to settle. `psyche start` keeps the desktop's plist variables. The drain also flushes every database, holds background writers and caps how long it can be extended. Erasing memory or uninstalling with data removes the snapshots too; `psyched devices` and `presence reset` refuse to migrate data themselves.
