---
"@psyche/gateway": minor
"@psyche/channels": minor
"@psyche/db": minor
"@psyche/cli": minor
"@psyche/desktop": minor
---

Second review of the update foundation. A pre-update snapshot is put back over live data only with positive evidence that this build's migrations were cut short (some, not all, of its pending migrations are applied and the data reads); otherwise the live data gets a fresh snapshot. A snapshot made from unreadable data is never a rollback point. A restore moves what it replaces to `backups/pre-update/.displaced-<time>/` and, when reusing a snapshot, puts back the databases only. One Gateway per data folder (`run/gateway.lock`). An unfinishable restore says why on the start-up screen and can be cleared with `psyche migrate --retry --restored-by-hand`; a damaged or foreign restore note fails closed. Channel messages held during an update are kept on disk and answered after the restart. Smaller fixes: retention ignores unreadable dates, the read-only probe, parent-folder fsync, and the uninstall sheet no longer deletes the snapshots (they travel to the Trash with the folder).
