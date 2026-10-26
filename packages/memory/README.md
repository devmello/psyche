# @psyche/memory

**Owner:** S07 (`prompts/s07-memory.md`). Feature ids: H1–H5, H7, H8 (M1); H6, H9, H10 (M2) ([docs/03-feature-spec.md](../../docs/03-feature-spec.md)).

The workspace the owner can read (`$PSYCHE_HOME/workspace/`, Markdown files, the source of truth) plus the index the agent searches (FTS5 + vectors in `state/psyche.sqlite`). Implements the `MemoryStore` contract and passes its conformance suite.

Docs: architecture §2 principle 6 and §4.8, data model §7, security §8, ADR-004, ADR-018.

## Public API (`src/index.ts`)

- `createMemoryStore({ db, workspaceDir, … })` → `SqliteMemoryStore` (runs `init()`: first-run templates, initial index). Options: `clock`, `timeZone` (daily-note dates; default the system zone), `embedder` (see `providerEmbedder`), `sqliteVec` (default on), `approvals` (`ApprovalCheck`; `brokerApprovalCheck(broker)` adapts the Permission Broker; default denies), `templatesDir` / `templateValues` (onboarding answers for `{{name}}` etc.), `onEvent` (`memory.file.changed`, `memory.job.updated`), `audit`, `flush` (`{ provider, model }` utility model).
- `SqliteMemoryStore` — the contract (`readFile`, `writeFile`, `listFiles`, `search`, `appendDailyNote`, `addClaim`, `listClaims`, `explain`, `forget`, `flush`) plus `writeFileAsOwner`, `delete`, `rename`, `listFileInfo`, `sync()` / `watch()` / `unwatch()`, `setPaused` / `paused`, `status()`, `reset({ dryRun })`, `startJob` / `finishJob` / `listJobs`, `idle()`, `close()`.
- `bootstrapContext(store, { session: "private" | "delegated" | "shared" })` → persona files under budgets with markers, today's and yesterday's notes, parsed identity.
- Tools: `memoryToolSpecs`, `MemoryTools#execute(name, input, ctx)` for `memory` (Anthropic `memory_20250818`), `memory_search`, `memory_explain`, `forget`, `remember`, `sessions_search`; `classifyMemoryCommand(input)` tells the broker the side effect and whether a `memory_protected_write` approval is needed.
- Gateway: `createMemoryHandlers(store, { persona? })` for every `memory.*` method; `MEMORY_METHODS`.
- Persona (H9): `readPersona`, `applyPersonaChange(store, change, { actor, approvalId?, etag? })`, `interpretPersonaInstruction(model, words, current)`; the `persona_update` tool; `classifyMemoryCall(name, input)` classifies every memory tool for the broker.
- Git sync (H10): `WorkspaceGit(store)` with `init()`, `setRemote(url)`, `sync({ remote?, branch?, localOnly? })`; `validateRemoteUrl`, `GITIGNORE`.
- Import / export: `importMemory` (ChatGPT, Claude, free text), `importOpenClaw` + `readWorkspaceFolder`, `confirmClaim`, `exportMemory` (zip).
- Jobs: `flushMemory` (also `store.flush`); `runDreaming(store, options)`, `dreamingDue`; `ensureDreamingAutomation(scheduler, { timezone })` and `withDreaming(store, launcher)` for the nightly run through `@psyche/scheduler`; `store.recordRecall` / `recallStats` (fed by `memory_search`).
- Formats: `parseDailyNote`, `applyDailyWrite`, `formatEntry`, `parseIdentity` / `serializeIdentity`, `parseDirectives` / `addDirective` / `activeDirectives`, `substituteTokens`, `chunkText`, `detectSensitive` / `blockingKinds` / `looksLikeInstruction`.

## Workspace layout

| Path | Role | Written by |
| --- | --- | --- |
| `SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `USER.md` | persona, injected every session (see sessions below) | owner; agent only with an approved `memory_protected_write` |
| `MEMORY.md` | curated memory, private sessions only | dreaming (the only writer besides the owner) |
| `memory/YYYY-MM-DD.md` | daily notes, indexed; today and yesterday injected | anyone, append-only (owner may edit) |
| `memory/*.md`, other `*.md` | topic notes, imports (`memory/imports/`) | anyone |
| `interests.md` | the Feed's interest ledger (S15 reads it) | agent, owner |
| `BOOTSTRAP.md` | first-run ritual, copied only into a fresh workspace, never re-created | the agent may only delete it |
| `DREAMS.md` | dreaming diary, not indexed | dreaming |
| `skills/` | workspace skills (S16); not indexed as memory | owner |

Templates come from `templates/` (S20). `{{token}}` placeholders are substituted at copy time with the onboarding values or the defaults in `templates/README.md` (`{{cred:…}}` is never touched). Hidden entries (`.git`, `.DS_Store`) are never listed, indexed, read or written through the store; `reset` keeps them.

## File formats

- **Daily notes** (data model §7.1): one bullet per entry, `- HH:MM [tag] text`, tag `owner | agent | system | untrusted | untrusted:<kind>:<source>` (no brackets, newlines or whitespace inside a tag). Indented lines continue the entry above. Each entry is its own index chunk, so provenance is exact. A line without a valid tag is `agent`.
- **`IDENTITY.md`**: YAML frontmatter (`name, creature, vibe, tagline, emoji, avatar, voice`, other keys preserved) and a free-form body. A broken frontmatter is reported, never thrown.
- **`USER.md` directives** (H8): `- YYYY-MM-DD active: …`; replacing one keeps the old line as `- YYYY-MM-DD superseded by YYYY-MM-DD: …` beside it. New directives go first in `## Directives (dated; latest wins)`.
- **`MEMORY.md`**: bullets dreaming writes end with their source dates `- text [2026-10-18, 2026-10-02]`; bullets without a source list are the owner's and dreaming never changes them.

## Provenance rules (security §8)

- Classes `owner | agent | untrusted | system`; when content mixes, the least trusted wins (`untrusted < system < agent < owner`). Unknown provenance is never `owner`.
- **Owner**: typed by the owner (Soul & Memory, `memory.remember`, edits outside Psyche such as Finder or git), or confirmed item by item (`memory.claims.confirm`). The `remember` tool keeps `owner` only when the text is one whole sentence or clause of the owner's own message in a private, untainted turn. An owner edit that keeps lines of an `untrusted` file leaves it `untrusted`; only a rewrite makes it the owner's.
- **Agent**: the model's own writes and inferences, imports until confirmed, approved edits of protected files (an approved agent edit never upgrades a file to `owner`).
- **Untrusted**: anything written in a tainted turn (the caller passes `provenance: "untrusted"` and an origin). Never written to a protected file, whatever approvals exist.
- **System**: templates and the store's own notes (retraction lines, dreaming diary).
- `addClaim` refuses an `owner` claim if any source (chunk id, path, `claim:<id>`) resolves to `untrusted` or `system` content or no longer resolves at all; other claims inherit `untrusted` / `system` from their sources, so a later confirmation is refused.
- Search can filter by provenance; `memory_search` excludes `untrusted` unless asked, and any result showing untrusted content is reported as `provenance: "untrusted"` so the agent loop taints the turn (security §3.6). Injected daily notes leave out `untrusted` entries by default.

## Write rules

1. Paths are workspace-relative, `/`-separated, no `.`/`..`/empty/hidden segments, ordinary name characters only, no credentials in names, and no symlinked component (`invalid_params`). Paths are canonicalized to the on-disk spelling and well-known names to their canonical case (`soul.md` is `SOUL.md` on a case-insensitive volume), and every rule applies to the canonical path. The memory tool maps `/memories` to the workspace root.
2. Protected files (`SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, `AGENTS.md`): `untrusted` → `policy_denied` (for a rename, the moved text's own provenance counts); agent writes, deletes and renames need an approval that `approvals(approvalId, { path, operation, contentSha256, newPath })` confirms → else `approval_required`. Each approval id is used once. Owner writes through the API need none. `BOOTSTRAP.md` may be deleted by the agent but never written, renamed onto or re-created.
3. Daily notes: non-owner writers may only append (new content must start with the old, on a new line); every appended line becomes its own entry carrying the writer's tag (or a quoted `untrusted:*` tag), so a forged `[owner]` or `[system]` becomes `[agent]` or `[untrusted:…]`. Imported daily notes get the same treatment as `agent`. Agents cannot delete, rename or `str_replace` a daily note.
4. Credentials and card numbers are refused on every write, checked line by line and on the whole content (`policy_denied`; keep them in the vault as `{{cred:slug}}`); chunks that contain one (an edit outside Psyche) are not indexed. The flush and imports also refuse government ids, account numbers and health details unless sensitive topics are allowed.
5. Optional `etag` (if-match) → `conflict` on mismatch. Writes are atomic (temp file + rename), files 0600, directories 0700.
6. Incognito threads and a paused memory write nothing from chats (tools and flush refuse); owner actions still work.

## Index and ranking

`memory_chunks` (stable ids from source + first line + text, so unchanged chunks keep embeddings and claim links), external-content FTS5 `memory_fts` (porter, unicode61) kept in sync by triggers, embeddings as float32 BLOBs, and a run-time `memory_vec` (sqlite-vec vec0, cosine) when the extension loads; otherwise exact cosine in process. Chunks: 400 estimated tokens (4 chars/token) with 80-token overlap, whole lines, HTML comments masked. Score `0.4·bm25_norm + 0.5·cosine + 0.1·0.5^(ageDays/30)`; `bm25_norm` is relative to the best keyword hit; dated notes age from their date, persona files and `MEMORY.md` are evergreen; vector-only candidates need cosine ≥ 0.5. Reindexing is incremental by file hash; embedding runs in the background (`idle()` awaits it) and a failing embedder leaves keyword search working.

## Forget

`forget(subject)` (≥ 3 characters, whole words, case-insensitive): retracts matching claims (`retracted_at`; the row stays for `listClaims({ includeRetracted })` but its text becomes `[retracted]` and its sources are cleared), removes daily-note entries that mention the subject or are linked to a retracted claim, removes matching lines from other notes (`MEMORY.md`, `USER.md`, topic notes, `DREAMS.md`; not `SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `BOOTSTRAP.md`, `skills/`), rebuilds the index for those files, appends a `[system]` retraction line with counts only, and records `memory.retraction` with counts in the audit log. `dryRun` reports the same without changes. The `forget` tool refuses tainted, incognito and paused turns and needs a `memory_protected_write` approval when a protected file would change (one protected file per call); the owner's `memory.forget` has no such gate.

## Dreaming (H6)

Nightly at 03:00 local, as a system automation in `@psyche/scheduler` (`ensureDreamingAutomation`); `withDreaming` wraps the scheduler's launcher so the run happens in-process, with no agent turn, and reports `no_reply` (nothing delivered; a failure becomes the scheduler's `task_failed` notification). Missed nights fold into one run. Deterministic, no model call:

1. **Candidates**: daily-note entries from the last 14 days with `owner` or `agent` provenance. `untrusted` and `system` entries are never candidates; sensitive ones (credentials, cards, ids, accounts, health) are refused unless sensitive topics are on.
2. **Score** (OpenClaw's weights): provenance 0.30, frequency across days 0.24, query diversity 0.15, recency 0.15, recall 0.10, richness 0.06; near-duplicates (keyword Jaccard ≥ 0.6) count as one fact. Owner facts need score ≥ 0.5; agent inferences also need ≥ 2 recalls by ≥ 2 different `memory_search` queries (`memory_recalls` stores query hashes only).
3. **Promote or merge**: into a similar sourced bullet (sources united, newest wording wins) or as a new bullet in the matching section (People, Preferences, Places, Routines, Accounts and services, Projects and goals, Decisions, Notes), with a claim for `memory_explain`. At most 20 a night.
4. **Supersede and decay**: a bullet whose claim was superseded takes the successor's text; a bullet whose newest source is older than 120 days is dropped. One night never removes more than 25 % of the sourced bullets.
5. **Owner wins**: bullets without sources are never changed; a promoted bullet the owner deleted is remembered by a keyword hash and never promoted again.
6. **Diary**: `DREAMS.md` gets `## YYYY-MM-DD` with Promoted / Merged / Superseded / Dropped lines and counts of what was not promoted (never the untrusted or sensitive text).

## Persona edits (H9)

`memory.persona.edit { instruction }` (the "Describe a change" pencil) sends the owner's words and the current persona to the utility model, which may answer only with persona fields as JSON (`name, creature, vibe, tagline, emoji, voice, description`; it can never set `avatar`, and other keys are ignored). Explicit `fields` / `description` apply on top. The change is an owner write to `IDENTITY.md` that keeps unknown frontmatter keys and the owner's guidance comments. It emits `persona.updated { identity, changed, avatarRequested }` right away, so the header changes within the turn. `avatarRequested` is true when the creature or name changed: the avatar renderer makes a new image and stores its asset id with `memory.persona.edit { fields: { avatar } }`, which does not request another one. The agent's `persona_update` tool does the same through a `memory_protected_write` approval, is refused in tainted turns, and refuses text that reads like an instruction (a persona is injected into every session, so it must not become a persistent injection).

## Git sync (H10)

`WorkspaceGit` syncs the workspace with the owner's own private repository (backing `psyche workspace sync`, S22). It runs the system `git` through `execFile` (never a shell) with `GIT_TERMINAL_PROMPT=0`, using the owner's SSH agent or credential helper; Psyche stores no git secret. `init()` writes a generated `.gitignore` (temp files, OS junk, `memory/imports/`) and later only adds missing lines. Remotes must be `https://`, `ssh://`, `user@host:path` or an absolute local path, never with credentials in the URL. Every file about to be committed is scanned and a credential or card number stops the sync, naming the file but not the value. `sync()` commits, fetches, rebases onto the remote branch (a conflict aborts the rebase, is reported, and nothing is pushed or forced), reindexes pulled files as the owner's edits, then pushes. There is no agent tool for it: only the owner starts a sync.

## People and projects graph (in progress, #651)

`GraphStore` (`src/graph/store.ts`) holds the graph from docs/memory/people-and-projects-2026.md in the main database (migration `202610251200_memory_graph.sql`):
- entities (person, org, project, place) and identifiers as merge keys (`normalize.ts`: Gmail folding, E.164, machine, role and bulk senders);
- facts and relations from the allowlists, with provenance, evidence, validity, supersession and history. Owner-only attributes and labels, sensitive and instruction-like values are refused, and a model never overrides the owner;
- interactions as pointers (no bodies), following the source's deletions;
- open loops (untrusted asks are only suggestions; dismissals are remembered);
- suggestions; merge and split, with do-not-merge remembered;
- forget, with a hashed identifier blocklist and `secure_delete`;
- retention, status, export and reset.

`cards.ts` renders each entity as `people/<slug>.md` / `projects/<slug>.md` (≤ 2,000 characters; hidden `<!--f:id-->` / `<!--l:id-->` markers). `CardSync` writes cards as a job; the agent cannot write them. It also turns the owner's edits back into corrections: changed or added facts become owner facts, deleted lines are retractions, ticked loops are done, deleted loops are dismissed, Notes are kept verbatim, and front-matter emails and phones are linked (or suggested for merging when they belong to someone else). `ingest.ts` (`GraphIngester`) is the deterministic pass over connector-neutral records:
- Contacts are owner facts (title, birthday, works-at, related names), and Contacts re-ingest respects the owner's corrections.
- Mail creates people past the threshold, skips bulk, machine and role senders, marks shared addresses, records direction, and applies the 3-day no-reply rule with reply-closes.
- Calendar attendees become people, never rooms.
- Messages give one interaction per conversation per day.
- Projects the owner names in chat are created.

The shared fixture world is `tests/fixtures/graph/world.json`.

- **Model pass (`model-pass.ts`, `runGraphModelPass`):** per entity with new interactions, one tool-less utility-model turn. It reads facts, the owner's corrections, the last 20 interaction headers (quoted as data) and up to 5 excerpts of the owner's own messages, and returns JSON. Facts and loops sourced from owner-authored items are `agent`/open; anything sourced from received items is `untrusted`/suggested. Unknown sources, forbidden attributes, sensitive or instruction-like values, and owner-only attributes are dropped. It has an input-hash cache, per-night entity and token caps, and deferral.
- **Projects (`projects.ts`):** confirmed projects claim interactions that name them and gain members (`system`). Repeated two-word subject phrases across three or more interactions with two or more people become project suggestions.
- **Handlers (`handlers.ts`, `createGraphHandlers`):** every `memory.entities.*`, `memory.loops.*` and `memory.graph.status` method as owner writes. Cards are refreshed after each change. Forget also removes the card and the person's mentions in notes.
- **Tools and recall (`tools.ts`):** `GraphTools` provides `people_lookup` (asks which one when names clash and contact strength is within 3×), `project_brief`, `waiting_on`, `meeting_prep` and `loop_update` (refused in tainted or incognito turns). Results carry `provenance: "untrusted"` when they show subjects, summaries, unverified facts or suggested loops. `entityRecall` gives one line per unambiguously named entity, private sessions only.

- **Privacy controls (§4.9):** `memory.graph.forgetAll` (needs the phrase "forget everything"; deletes every graph table with `secure_delete`), `memory.graph.deleteSource` (a source's interactions, the facts, relations, loops, identifiers and aliases derived only from it, and the people it alone knew; the owner's facts stay), and `memory.graph.blocklist.list` / `.add` / `.remove` (hashed values with masked hints; a blocked domain covers every address at it). Each delete has a dry run.
- **Meeting prep data (`meetingPrep`):** attendees, their open loops and last interactions, and the project for one meeting, found by interaction id, by calendar event (`source` + `externalRef`) or by time. The schedule and the prep card belong to the mail and meetings workstream.
- **Nightly steps:** `withDreaming(store, launcher, options, after)` runs each `NightlyStep` after dreaming; a step's failure only shows in the run summary.

The Gateway composes all of this in `apps/gateway/src/compose/people.ts`: handlers, the five tools while `memory.graph.enabled` is on (owner turns only), events, Search documents, card edits, and the graph pass after dreaming. Connector ingest follows in #732; entity recall waits for #733.

## The teaching loop (#679)

`src/teaching/` is the Gateway side of docs/agent/teaching-loop-2026.md §3–4 (migration `202610251600_memory_teaching.sql`):

- `TeachingStore`: `feedback_events` (the owner's signals; evidence only; kept 180 days), `lessons` (what Psyche concluded, where it wrote it, what it replaced, its sources and confidence) and `feedback_weekly` counts that outlive the events. A forgotten lesson keeps only its id, kind, dates and a fingerprint of what it was, so the same evidence cannot write it again.
- `confidence.ts`: 0.9 for a correction ("You told me"), 0.6 for a reason chip or a redo ("From your feedback"), 0.3 for one implicit signal (never written), 1 when the owner confirms. Only explicit feedback reaches the 0.6 write threshold; "helpful" never creates a lesson.
- `router.ts`: the utility model reads the owner's words and the target (quoted as data, with the lessons that already exist) and proposes `{kind, statement, value, scope, replaces?}`. Deterministic rules then refuse instruction-like, sensitive (health, politics, religion, sexuality, money), world-opinion and untrusted-derived text, apply the owner's scope chip (`once` makes no lesson), and pick one destination: `style` → SOUL.md `## How I write for you` (global) or USER.md `## Preferences` / the graph (scoped); `fact` → USER.md Learned via `learnUserFacts`; `entity` → the graph (`owner_feedback`, `lesson:<id>`), else USER.md People; `approach` → `skills/<name>/LESSONS.md` or AGENTS.md `## Lessons`; `parameter` → the automation; `boundary` → a USER.md directive plus a standing `ask` rule.
- `writers.ts` (`LessonWriter`): one writer per destination, only lines tagged `[ls_…]` (or the learned-fact and directive formats), never the owner's own text; budgets per file (USER.md 4,000, others 20,000, a skill's `LESSONS.md` 2,000). `remove` puts back what a lesson replaced.
- `service.ts` (`TeachingService`): owner-only (`forbidden` for delegated persons and groups, `policy_denied` for incognito, paused or switched-off learning), writes at once for USER.md and the graph under `memory.userProfile.review: auto`, else a `memory_protected_write` card with `fromLesson` and the line diff, written once after approval (the binding is verified and consumed); declined cards leave the lesson `dormant`. A lesson supersedes another only when the router names it and it sits on the same destination (single-valued destinations always do); a repeat of a live lesson adds a source instead of a line. `confirm`, `edit`, `forget` (with derived MEMORY.md lines and the superseded lesson restored), `deleteEvent` and `resume` (cards open at a restart).
- `growth.ts` (`computeGrowth`): `growth.summary` over events, lessons, weekly counts, approvals, tasks and automations. Each rate is null below 10 events, comes with its count and the previous window's figures (none for `all`), and lists the lesson and feedback ids behind it. Milestones are dated facts (first week and month, first lesson, 10 lessons, 100 tasks, first automation, first skill from a routine), never streaks or scores.
- Retention and forgetting (§3.5): `retain()` deletes events older than 180 days and keeps the weekly counts. `forgetAll()` forgets every lesson, newest first, so each one restores its predecessor's line, then deletes every event. `recordDraftSent()` counts a sent draft as an outcome and records `draft_edited` only for a heavy edit (≥ 0.2), keeping hashes, never texts. `memory.export` adds `lessons.json` and `feedback.json` when the handlers get `teaching`; `memory.reset` clears both tables.

## Imports

Imports are data (security §8): ChatGPT and Claude exports (JSON shapes with `content` / `text` / `memory` strings, or Markdown / text) and free text are split into items, capped (2 MB input, 500 items, 500 characters each), filtered (credentials, cards, ids, accounts, health), scanned for instruction-like text (flagged, confidence 0.2), written to `memory/imports/<format>-<date>.md` and staged as `agent` claims. The owner promotes them one by one with `memory.claims.confirm` (idempotent). Whole OpenClaw files are checked for credentials and card numbers; the claims staged from them get the full filter. An OpenClaw workspace imports with the same names (ADR-018), but never overwrites an existing or owner-edited file (those land in `memory/imports/openclaw/`), never installs `skills/` (also routed there, for the skills flow to scan and approve), and skips `BOOTSTRAP.md`.

## Sessions

`bootstrapContext` follows `templates/README.md`: private sessions get `SOUL, IDENTITY, AGENTS, USER, MEMORY` (+ `BOOTSTRAP` while it exists) and today's/yesterday's notes; delegated sessions `SOUL, IDENTITY, AGENTS`; shared (group) sessions `IDENTITY, AGENTS`. Budgets: 20,000 characters per file, 4,000 for `USER.md`, 60,000 total; overflow is cut with `[truncated: …]`, a missing file becomes `[missing file: …]`, and a file holding untrusted content becomes `[withheld: …]` (defence in depth; the write rules already prevent it).

## What is stubbed

- `sessions_search` needs the Gateway's transcript query (`TranscriptQuery`, S01).
- Token counts are estimates; a real tokenizer per embedder is not wired.
- A forgotten subject can come back if the owner states it again later (by design) or if an old transcript copy is flushed again; no "forgotten" list is kept, because storing the subject would defeat forgetting.
