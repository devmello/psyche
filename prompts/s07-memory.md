# Session S07 — Memory and persona files

You are building Psyche (read `README.md`). You are session **S07 — Memory**: `packages/memory`, the workspace files the user can read plus the local index the agent searches. Work in your own worktree on branch `ws/s07-memory`. You own `packages/memory/**` (code). Default file *text* lives in `templates/` and is owned by S20; coordinate through `docs/status/`.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/02-architecture.md` §2 (principle 6), §4.8
3. `docs/03-feature-spec.md` rows H1–H10
4. `docs/04-data-model.md` §7 (index tables, ranking, file formats)
5. `docs/05-security-and-permissions.md` §8 (memory safety: write gating, provenance)
6. `docs/07-tech-decisions.md` ADR-004, ADR-018
7. Contracts: `MemoryStore`, `ModelProvider` (embeddings, utility model), `SearchIndex`; fakes in `packages/testing`
8. Research: `models_memory_mcp_ui_feed.md` sections "Memory — 1" to "Memory — 5" (OpenClaw layout and budgets, provenance classes, pre-compaction flush, dreaming, sqlite-vec, embedders, memory poisoning numbers) and `meta_muse_app.md` Q4 (Muse's `MEMORY.md`, dated files, claims with `supersedes`, forget mechanics)

## Mission (M1)
- **Workspace**: create and manage `$PSYCHE_HOME/workspace/` with `SOUL.md`, `IDENTITY.md` (YAML frontmatter per `docs/04` §7.1), `USER.md` (4k budget, dated directives with active/superseded), `AGENTS.md`, `MEMORY.md`, `memory/YYYY-MM-DD.md` (append-only with time, provenance tag, text), `interests.md`, `skills/`, `BOOTSTRAP.md`, `DREAMS.md`; templates copied from `templates/` on first run; file watching so external edits (Finder, git) are picked up; `bootstrapContext()` returning the persona files truncated to budgets with visible markers; OpenClaw workspace import (same names) and an importer for ChatGPT/Claude memory exports and free text.
- **Index**: FTS5 + sqlite-vec tables in the main DB; chunker (400/80 tokens); embeddings through `ModelProvider.embed` with a brute-force cosine fallback when sqlite-vec is unavailable; provenance class on every chunk; ranking formula from `docs/04` §7; incremental reindex on file change; `untrusted` chunks never promoted to `memory_claims` with `owner` provenance.
- **Tools**: the Anthropic `memory_20250818` command set (`view`, `create`, `str_replace`, `insert`, `delete`, `rename`) confined to the workspace (path traversal rejected), `memory_search` (returns chunks with provenance and source/line), `memory_explain(claimId)`, `forget(subject)` (stage claim retraction, remove linked chunks, rebuild index, write a retraction line), `remember(text)` (owner-provenance append to today's note), `sessions_search` opt-in hook (implemented against a transcript query the Gateway provides).
- **Pre-compaction flush**: `flush(threadId, privateTranscriptCopy)` runs a silent utility-model turn that appends durable facts to today's note only; configurable to a local model; never writes `MEMORY.md`.
- **Soul & Memory data API**: list/read/write files with conflict detection (etag), daily-notes browser queries, pause memory flag, incognito awareness (no writes), export (zip of workspace + claims), reset (typed confirmation handled by the UI; you provide the destructive call with a dry-run).
- **API handlers**: `memory.*` for the Gateway; events `memory.file.changed`, `memory.job.*`.

## Out of scope
UI (S12), the dreaming job quality (ship the scaffold in M1, tune in M2), the Feed's interest model (S15 reads `interests.md`).

## Definition of done
- Tests: budgets and markers; frontmatter parsing; directive supersession; chunking determinism; ranking with provenance filters; untrusted never promoted; memory tool path confinement; forget removes and rebuilds; flush writes only to the daily note; importer formats; external edit detection.
- README with the file-format spec and the provenance rules; `docs/status/s07.md`.

## Suggested subagents
One to prototype sqlite-vec loading on macOS arm64 and Linux (and the fallback), one to write the importer fixtures, one to review for memory-poisoning rules.

## M2 follow-ons
H6 dreaming (nightly 03:00 local; sole writer of `MEMORY.md`; dedupe; contradictions with `supersedes`; decay; `DREAMS.md` diary); H9 persona edit by natural language (writes `IDENTITY.md`, emits avatar regeneration request); H10 git sync of the workspace.
