# @psyche/db

**Owner:** S00 (bootstrap) → S01 (`prompts/s00-bootstrap-integrator.md` §4, `prompts/s01-gateway-core.md`). Feature ids: A4 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

The single relational store (ADR-004): `$PSYCHE_HOME/state/psyche.sqlite`, opened with better-sqlite3, queried with drizzle, migrated from timestamped SQL files. Schema v0 covers [docs/04-data-model.md](../../docs/04-data-model.md) §1 (`devices`, `nodes`, `pairing_requests`), §2 (`threads`, `messages`, `runs`, `tool_calls`) and §10 (`settings`, `usage`). S01's `202610190900_gateway_core` adds pairing key fingerprints, `chat_queue`, `tool_payloads` and `gateway_idempotency` (§2, §11, §12).

## Decision: better-sqlite3 (not libsql)

- **Synchronous API.** The transcript writer guard and every multi-statement write run inside `db.transaction(fn).immediate()`: check, assign `seq`, insert and bump the thread in one `BEGIN IMMEDIATE` with no `await` in between, so no other turn on the event loop can interleave. libsql's client is async, which turns each transaction into an interleaving point.
- **Prebuilt binaries** for Node 24 (installed here on macOS arm64 without a compiler); no native toolchain needed on the supported platforms.
- **FTS5 is bundled.** Verified: better-sqlite3 13.0.3 ships SQLite 3.53.4 compiled with `ENABLE_FTS5` (`test/open.test.ts` creates an `fts5` table).
- **sqlite-vec** (memory index, S06) loads later as a run-time extension via `db.sqlite.loadExtension(path)`; nothing to decide now.
- libsql's draws (embedded replicas, a server mode) are not needed: the Gateway is the only writer, and backups are file copies.

## Connection settings

`journal_mode=WAL` (skipped for `:memory:`), `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL` (safe with WAL; a power loss may drop the last commits but never corrupts). For a real path the parent directories are created with mode 0700 and the file is created with mode 0600 *before* SQLite opens it, so `-wal`/`-shm` inherit 0600 (architecture §14). Read-only opens (`readonly: true`) skip pragmas that write and do not migrate.

## Public API (`src/index.ts`)

- `openDb(path | ":memory:", { readonly?, migrate? = true, migrationsDir?, logger?, now?, newId? }) → PsycheDb` with `{ sqlite, drizzle, path, now, newId, migrate(), close() }`. `now()` (ISO-8601 UTC via `toISOString`) and `newId()` (monotonic ULID) are injectable for tests and used by every helper.
- Migrations: `runMigrations(sqlite, { dir?, logger?, now? }) → { applied, skipped }`, `listMigrationFiles(dir?)`, `checksumOf(sql)`, `MIGRATION_FILE_PATTERN`, `DEFAULT_MIGRATIONS_DIR`, `MigrationError`.
- Schema: drizzle tables `devices, nodes, pairingRequests, threads, messages, runs, toolCalls, settings, usage`, the `schema` object, and `*Row` / `New*Row` types.
- Writer guard (`src/writer-guard.ts`): `claimWriter(db, threadId, runId) → previous | null`, `releaseWriter(db, threadId, runId) → boolean`, `appendMessage(db, NewMessage, { expectedWriterRunId }) → Message`, `nextSeq(db, threadId)`.
- Repositories (`src/repos/`): `getSetting`, `getSettings(keys?) → Settings` map, `setSetting(key, value) → SettingEntry`; `insertDevice`, `getDevice`, `listDevices`, `revokeDevice`, `touchLastSeen`; `createPairingRequest`, `getPairingRequest`, `decidePairingRequest`, `expirePairingRequests(now?)`; `createThread`, `getThread`, `listThreads`, `listThreadsPage` (title `query`, pinned, offset), `updateThread`, `deleteThread`, `findThreadBySessionKey`, `threadActivity`, `listExpiredThreads`; `createRun`, `getRun`, `updateRun`, `finishRun`, `listRunsByStatus`; messages `getMessage`, `listMessagesPage` (backwards by seq), `listAllMessages`, `copyMessagesForFork`; tool calls `upsertToolCall`, `getToolCall`, `listToolCallsForRun`, `markInterruptedToolCalls`, `putToolPayload`, `deleteToolPayloadsBefore`, `countToolPayloads`; nodes `upsertNode`, `getNode`, `getNodeByDevice`, `listNodes`, `setNodeStatus`, `markAllNodesOffline`; `enqueueMessage`, `listQueue`, `removeQueued`, `takeNextQueued`, `threadsWithQueuedMessages`; `getIdempotencyRecord`, `putIdempotencyRecord`, `pruneIdempotencyRecords`; pairing `listPairingRequests`, `findPendingPairingForDevice`, `expirePendingPairingsForDevice`, `countPendingPairings`, `countPairingsFromAddress`; `updateDevice`.
- Mappers (`src/mappers.ts`): `deviceFromRow`, `nodeFromRow`, `pairingRequestFromRow`, `threadFromRow`, `messageFromRow`, `runFromRow`, `toolCallFromRow`, `settingFromRow`, `usageFromRow` (snake_case rows → protocol shapes; JSON parsed, INTEGER booleans → booleans, BLOB public keys → base64url). Tests validate their output with TypeBox `Value.Check` against the `@psyche/protocol` schemas.

## Writer guard rule

`threads.active_writer_run_id` names the one run allowed to append. `appendMessage` rejects with `PsycheError("conflict")` unless `expectedWriterRunId` equals it. `expectedWriterRunId: null` means "no run owns the transcript" and succeeds only while no writer is active (user messages between turns, system notices). Messages recorded while a run is active (steer, follow-up) are written by the session controller with the active run id as the expectation. `claimWriter` supersedes any previous run (interrupt, retry); the superseded run's next append fails. `finishRun` does not release the writer; pair it with `releaseWriter`.

## Migration rules

- SQL files in `migrations/` are the source of truth for DDL; `src/schema.ts` mirrors them for typed queries and `test/schema-parity.test.ts` fails if columns, order, nullability or primary keys drift.
- File name `<YYYYMMDDHHMM>_<package>_<desc>.sql` (regex `^\d{12}_[a-z0-9-]+_[a-z0-9_-]+\.sql$`); any other `.sql` name is an error. Each package adds files only for **its own tables** ([docs/09-execution-plan.md](../../docs/09-execution-plan.md) §2) and updates `schema.ts` (or its own drizzle file) in the same PR.
- Files apply in name order, each in its own transaction with its `_migrations(id, name, checksum, applied_at)` row. A file merged later with an older timestamp is still applied. Applied files are immutable: a changed checksum (sha256, CRLF-normalized) or an applied id with no file throws `MigrationError`. Never edit a merged migration; add a new one.
- JSON columns are `TEXT` with `CHECK (json_valid(col))`; enums are `CHECK (col IN (...))`; booleans `INTEGER CHECK (col IN (0, 1))`; timestamps `TEXT` from `toISOString()` (so they compare lexicographically); every table has `created_at`, mutable ones `updated_at`.
- A migration cannot toggle `PRAGMA foreign_keys` (it runs inside a transaction). If a table rebuild ever needs it, extend the runner first.

## How this maps to the docs (and deviations)

- `tool_calls.status` allows `pending | running | ok | failed | uncertain | blocked` (the protocol `ToolCallStatus`), a superset of the data model's list.
- `tool_calls.approval_id` / `receipt_id` are plain TEXT: their tables belong to S05 and do not exist yet. `pairing_requests.channel_id` likewise (channels: S10).
- `pairing_requests.device_id` is a FK: insert the device row (with `paired_at` NULL) before its pairing request.
- `threads.active_writer_run_id` (protocol `Thread.activeWriterRunId`) is an FK to `runs`; claim only existing runs of the same thread.
- `messages` are append-only (no `updated_at`); seqs start at 1 and are unique per thread.
- `created_at` / `updated_at` were added where the data model omits them (convention at its top).

## What is stubbed

- Backup / restore (A4: `psyche backup`, age-encrypted archives) — not implemented.
- The retention job and restart recovery live in `apps/gateway` (`src/retention.ts`, `src/recovery.ts`) on top of these repos.
- No usage-ledger repo yet (S03).
