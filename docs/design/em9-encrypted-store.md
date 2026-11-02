# EM9a: encrypted memory store, building blocks

Lives in `packages/memory/src/secure/encrypted.ts`. Backed by the SQLCipher results in `em-s1-sqlcipher-spike.md`. **Nothing calls it yet**; psyche.sqlite is still where memory data lives.

What exists: `openEncrypted` (raw 32-byte key, wrong key throws `unauthorized`, dir 0700, file 0600), `MemoryKeyFile` (0600 key file, atomic replace, refuses loose modes), `copyTables` (ATTACH the plaintext db, copy `MEMORY_STORE_TABLES`, rebuild external-content FTS, verify row counts and foreign keys), `deleteEverything` (secure-delete all rows, drop vec tables, re-key, VACUUM, truncate WAL; the old key then opens nothing).

## What EM9b still needs
1. Point `GraphStore`, `EverythingStore`, memory files/claims and the scheduler's memory jobs at the encrypted handle; keep psyche.sqlite for everything else.
2. One-time migration: `copyTables`, then delete the plaintext rows and VACUUM; keep it resumable.
3. Key custody: the key file is the fallback. Preferred is a DEK wrapped by the vault, but the vault wrappers need Touch ID and the 3 a.m. run cannot prompt. That needs a new mac-helper capability (unwrap without prompt); it does not exist.
4. Backups: include the key wrapped, never in the clear next to the db.
5. Verify on Windows and Linux (prebuilt binaries, file modes).
6. Wire "delete everything" in the UI to `deleteEverything` and replace the stored key.
