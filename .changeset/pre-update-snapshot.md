---
"@psyche/gateway": minor
"@psyche/db": minor
"@psyche/cli": minor
"@psyche/desktop": minor
---

The Gateway makes a safety copy before it applies pending database migrations. Every database and `config.json` go into `~/.psyche/backups/pre-update/<from>-to-<to>-<time>/` (SQLite files with the online backup API; the newest 3 are kept, `PSYCHE_PRE_UPDATE_KEEP` changes that). If a migration fails, the copy is put back and the Gateway refuses to start with a plain message, which the desktop shows instead of "did not answer". The same build is not retried on every restart. Keys in `config.json` that this version does not know are now warned about once and kept, never fatal and never removed, so a rollback still starts; `psyche migrate --check` reports them as a warning. `upgrade-roundtrip.mjs` now also covers a failed migration restoring the snapshot.
