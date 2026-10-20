# @psyche/backup

**Owner:** S22. Feature U4 (backups) in [docs/03-feature-spec.md](../../docs/03-feature-spec.md); architecture §12 (storage layout), security §14 (data handling).

Backup archives of `$PSYCHE_HOME`, shared by `psyche backup` (apps/cli) and the Gateway's `backup.*` methods, so both write and read the same files.

## Format

`psyche-<time>.tar.gz[.age]`: a gzip'd tar of `state/` (SQLite and the channel sessions in `state/channels/`), `workspace/`, `vault/`, `library/`, `audit/` and `config.json`, plus `psyche-backup.json` (`format`, `version: 1`, `createdAt`, the producer, the entries, and every file's path, size and SHA-256). Encrypted with [age](https://age-encryption.org) by passphrase (scrypt) or X25519 recipients unless the owner opts out. Not included: device keys (`cli/`), sockets (`run/`), logs, browser profiles, sandbox workspaces, VM disks.

## Public API

| Export | What |
| --- | --- |
| `createBackup(home, out, encryption, producer, { now, snapshots })` | Mirrors the entries into a hard-link staging tree inside `$PSYCHE_HOME`, swaps in `snapshots` (home-relative path → writer; the Gateway passes SQLite's online backup for `state/psyche.sqlite`, and the live file's `-wal`/`-shm`/`-journal` are left out), hashes the staged files, then tar → gzip → age → `out` (0600). Without snapshots the files must be quiescent (the CLI stops the Gateway). |
| `verifyBackup(file, decryption, scratch)` / `extractAndVerify` | Decrypts to a 0600 temp file (nothing is extracted before age has authenticated every chunk), extracts under `scratch` (0700), checks every hash and that nothing unlisted is present. |
| `restoreBackup(file, decryption, home, { force })` | Verifies, then moves the entries into place (existing ones to `.pre-restore-<time>/` with `force`), rolling back on failure; modes 0700/0600. CLI only: it replaces the Gateway's own state. Leaves `security/restored.json` for the next Gateway boot, which replays the revocation ledger (`security/`, never archived) so a restored database cannot bring back a revoked device or grant, and the vault drops deleted items at start and unlock (S23 design-26). |
| `parseManifest` | Treats the manifest as untrusted: only known top-level entries, no `..`, absolute or empty path segments. |
| `listBackups`, `backupEntry`, `backupFileName`, `resolveBackupFile`, `markVerified`, `deleteBackup`, `ensureBackupsDir`, `backupsDir` | The `$PSYCHE_HOME/backups/` directory (0700): archives addressed by file name only (symlinks out of it refused), newest first, last successful verification in `.verified.json`. |

Errors are `PsycheError`s: `invalid_params` (wrong key, damaged archive, bad manifest or file name), `not_found`, `conflict` (restore over existing state without `force`), `internal` (tar failed).

## Dependencies

`age-encryption` (BSD-3-Clause) and the system `tar` (bsdtar on macOS, GNU tar on Linux). No SQLite: callers that hold a database pass a snapshot writer.

Tests: `test/archive.test.ts` (round trips, wrong key, tampering, restore rules), `test/store.test.ts` (snapshots, listing, names, symlinks). The Gateway's online backup and the Gateway → CLI round trip are tested in `apps/gateway` and `apps/cli`.
