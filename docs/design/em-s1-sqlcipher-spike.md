# EM-S1: SQLCipher + sqlite-vec + FTS5 in one build (spike report)

Status: done 2026-11-02. Report only; nothing in the product changed. Question from
[everything-memory-2026.md](everything-memory-2026.md) §11.1 and the search-index encryption
question (decision 11): can one encrypted SQLite file hold relational tables, FTS5 and sqlite-vec,
at an acceptable cost?

**Answer: yes.** The `better-sqlite3-multiple-ciphers@13.0.3` build that `packages/vault` already
ships does all three, so encrypting `memory.sqlite` or `search.sqlite` adds **no new native
dependency**.

## What was run

A throwaway script (not committed) on macOS arm64, Node 24, SQLite 3.53.4, `sqlite-vec` 0.1.9,
with a synthetic store of 40k facts, 60k citations (one-line quotes) and an FTS5 index over them.
Plain `better-sqlite3@13.0.3` was measured next to it.

| Check | Result |
| --- | --- |
| SQLCipher mode | `cipher='sqlcipher'`, `legacy=4` (SQLCipher 4 defaults), raw 32-byte key as `x'<hex>'` (so no key-derivation cost at open) |
| File on disk | not plaintext (`SQLite format 3` header absent); WAL mode works and the WAL is encrypted too |
| Wrong key | `SQLITE_NOTADB` on the first read; the file is never half-opened |
| FTS5 | works unchanged (create, insert, `MATCH`) |
| sqlite-vec | `db.loadExtension(sqliteVec.getLoadablePath())` loads into the ciphers build; `vec0` tables create, insert and KNN correctly (`vec_version()` = v0.1.9) |
| File size | 13.1 MB encrypted vs 12.6 MB plain (+4%) |
| Build (insert 100k rows in one transaction) | 437 ms vs 258 ms (about 1.7x) |
| Open (key, WAL, first read) | 0.5 ms either way |
| 200 FTS5 queries | 239 ms vs 248 ms (no difference) |
| Full scan with `LIKE` over 60k citations | 27 ms vs 5 ms (reads are the cost: every page is decrypted) |
| Memory | +1 MB RSS to open; process RSS 115 MB at the end including a 5,000-vector index |
| 5,000 x 384-dim vectors | insert 440 ms; one KNN query 0.7 ms |
| Re-key (`PRAGMA rekey`), 40k facts | 516 ms; the old key is refused afterwards and all rows read under the new key |

## What it means

- **EM9 is feasible as designed.** `state/memory.sqlite` can be created with a DEK from the same
  wrapping mechanism as the vault; "Delete everything" can re-key (about half a second at this
  size, then the free pages are unreadable) and then vacuum.
- **Search index (decision 11):** the same build works for `search.sqlite` including its FTS5 and
  vector tables. The measurable cost is full-table scans (about 5x) and bulk writes (about 1.7x);
  indexed and FTS reads are unaffected. A backfill of a large mailbox is the place to watch.
- **RAM:** negligible. This favours the owner's runtime-RAM-over-disk rule.
- **Drizzle / types:** the ciphers package has the same API as `better-sqlite3` (`pragma`,
  `transaction`, `loadExtension`, `prepare`); `packages/vault` carries a small type shim for it.
  `packages/db`'s `openDb` would need an option to open with a key, and the drizzle layer accepts
  the instance as is.

## Not covered (so not claimed)

- Windows and Linux builds (the Gateway also runs on servers): only macOS arm64 was run. The
  package ships prebuilds, but each platform needs its own check before EM9 ships there.
- Migration of an existing plaintext `memory_*` / `graph_*` store into the encrypted file (EM9
  does it with `ATTACH` + copy, or `sqlcipher_export`).
- Backup wrapping: the DEK has to travel in the backup wrapped by the recovery key (design §11.2).
- Two SQLite builds in one process (plain `better-sqlite3` for `psyche.sqlite` and the ciphers
  build for the encrypted files) cost a few MB of code each; not measured separately.
