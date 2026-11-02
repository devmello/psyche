# EM9a: encrypted memory store, building blocks

Lives in `packages/memory/src/secure/encrypted.ts`. Backed by the SQLCipher results in `em-s1-sqlcipher-spike.md`. **Nothing calls it yet**; psyche.sqlite is still where memory data lives.

What exists: `openEncrypted` (raw 32-byte key, wrong key throws `unauthorized`, dir 0700, file 0600), `MemoryKeyFile` (0600 key file, atomic replace, refuses loose modes), `copyTables` (ATTACH the plaintext db, copy `MEMORY_STORE_TABLES`, rebuild external-content FTS, verify row counts and foreign keys), `deleteEverything` (secure-delete all rows, drop vec tables, re-key, VACUUM, truncate WAL; the old key then opens nothing).

## What EM9b still needs
1. Point `GraphStore`, `EverythingStore`, memory files/claims and the scheduler's memory jobs at the encrypted handle; keep psyche.sqlite for everything else.
2. One-time migration: `copyTables`, then delete the plaintext rows and VACUUM; keep it resumable.
3. Key custody: the key file is the fallback. Preferred is a DEK wrapped by the vault, but the vault wrappers need Touch ID and the 3 a.m. run cannot prompt. The owner chose a non-biometric Keychain item (WhenUnlockedThisDeviceOnly, no Touch ID) for derived-data keys; the search session is adding that slot as a helper capability in #1072. EM9b should reuse it, not build a second one (coordinate with local_7677c6d9-f120-4990-a7bf-96694a501e78).
4. Backups: include the key wrapped, never in the clear next to the db.
5. Verify on Windows and Linux (prebuilt binaries, file modes).
6. Wire "delete everything" in the UI to `deleteEverything` and replace the stored key.

## EM9b inventory (2026-11-02, after #1083 landed)

Ready on main: `DeferredOpen` (open once a key arrives), `DerivedKeyStore` (helper item, no Touch ID), `resolveSearchKey`/`openSearchDatabase` as the pattern to copy, and EM9a's `copyTables`/`deleteEverything`.

Consumers of the memory tables that would move off `psyche.sqlite`:
- `GraphStore` (`compose/people.ts`), `EverythingStore` (`people.ts`, `everything.ts`), `SqliteMemoryStore` (`createMemoryStore`, which runs `init()` and an initial index at compose time).
- Raw SQL on `graph_*` through the main handle: `compose/insights.ts`, `compose/people-sources.ts`, `compose/index.ts`, plus the Life search scan.
- The People poll, nightly pass, dreaming steps and `memory-recall` all reach the store through those objects.

What makes this more than wiring:
1. **Late key.** The helper connects after the Gateway is composed, but these stores are built synchronously and handlers use them straight away. Options: (a) a `LateDatabase` handle that delegates once open and throws `unavailable` before (every consumer keeps its code; handlers return a clear error and the nightly pass skips), or (b) compose the memory half after the key. (a) is smaller; it needs the memory store's `init()` moved to "on open".
2. **Migration and rollback.** First open copies with `copyTables`, verifies counts, then deletes the plaintext rows and VACUUMs; a crash in between must be resumable and never leave two live copies. The setting must be off by default, and turning it off must copy back.
3. **No cross-DB joins** exist today (`insights.ts` joins only `graph_*` tables), but the drizzle schema, `schema-parity` test and migrations still describe these tables in the main file; they would need a "memory" migration track.
4. **Backups and export** (`data` section) must include the encrypted file and the wrapped key together, never the key in the clear.

Recommendation: do (1) as its own PR with the switch still off and a test that a pending key returns `unavailable` everywhere, then the migration (2) as a second PR; only then expose a Settings switch (no dead switches).

## EM9b as built (2026-11-02)

- Part 1 (#1094): `compose/memory-db.ts` `resolveMemoryStore` + `LateDatabase` behind `DeferredOpen`. Off returns `psyche.sqlite`'s own handle (same object). Closed store: reads empty, writes throw `unavailable`.
- Part 2: move state in `memory.encrypt.state` (`copied` → `cleared`), resumable; a file without a recorded copy is discarded and redone. `syncSchema` rebuilds drifted tables from `psyche.sqlite`'s definitions on every open; a lint test fails on a new data-only migration that touches a moved table. `memory.store.setEncrypted`: on takes effect at the next start; off copies back (verified) and repoints the live handle at `psyche.sqlite`, then deletes the file and key. While the plain rows are cleared, the encrypted file opens even if the switch was flipped by hand.
- Two SQLite libraries never share a file: rows are streamed between the plain and encrypted connections; nothing is ATTACHed across them.
- Still open: backups/export including the encrypted file with its wrapped key; persisted fact vectors in the encrypted file; the Mac helper item is left in the Keychain after turning off.
