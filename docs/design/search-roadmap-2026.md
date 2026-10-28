# Search roadmap 2026: a searchable life you can ask in English

Status: plan. It builds on `search-2026.md` (#900, phases S1–S4 merged), which made the main index real: FTS5/BM25 at `state/search.sqlite`, an optional on-device embedder (multilingual-e5-small), RRF fusion, backfill and status. This doc covers what comes next: **index more, store more, search better, answer with sources.** The eval harness in `packages/search/eval` (§9) measures every step.

The owner's framing: search is Psyche's most powerful feature, because it can "build a searchable version of your life you can prompt using English". Today it is a good keyword index over chats, tasks and the Library. Most of the owner's life (mail, messages, notes, calendar, files) is reachable only through live connector tools, and an English question typed into Search usually returns nothing.

Ingest-time **context cards and contextual chunks** landed in #1007 (grounded-ingest) and are only referenced here (§3.6). This doc does not duplicate them.

## 1. Where we are (baseline)

The baseline from the harness on current main, BM25 only (no embedder, no model), on a 425-doc synthetic life of one owner with 150 questions. "Production" coverage indexes only what the Gateway indexes today. "Full" indexes every source.

| Coverage | Mode | zero results | R@5 | R@10 | hit@10 | MRR | nDCG@10 | cite P@3 (mock) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| production | raw | 0.967 | 0.009 | 0.009 | 0.020 | 0.020 | 0.011 | 0.020 |
| production | keywords | 0.073 | 0.091 | 0.107 | 0.213 | 0.140 | 0.096 | 0.077 |
| production | rules | 0.073 | 0.089 | 0.101 | 0.207 | 0.142 | 0.097 | 0.086 |
| full | raw | 0.893 | 0.096 | 0.099 | 0.107 | 0.100 | 0.096 | 0.097 |
| full | keywords | 0.013 | 0.447 | 0.583 | 0.760 | 0.510 | 0.474 | 0.317 |
| full | rules | 0.013 | 0.491 | 0.600 | 0.787 | 0.587 | 0.518 | 0.381 |

R@10 by class, full coverage:

| Class (n) | raw | keywords | rules |
| --- | --- | --- | --- |
| exact (25) | 0.241 | 0.867 | 0.811 |
| paraphrase (30) | 0.000 | 0.430 | 0.430 |
| temporal (25) | 0.000 | 0.363 | 0.465 |
| person (20) | 0.000 | 0.739 | 0.800 |
| list (20) | 0.050 | 0.598 | 0.611 |
| multihop (15) | 0.000 | 0.500 | 0.500 |
| crosslingual (5) | 0.000 | 0.300 | 0.300 |
| filter (10) | 0.780 | 0.800 | 0.800 |

"Mock" citation means the top 3 hits are cited as they are. The `--llm` mode (Haiku answers) is implemented but has not been run yet.

What the numbers say:

1. **English questions mostly fail today.** 97 % of questions return nothing with production coverage, and 89 % with full coverage. Bare words are ANDed (`query-parser.ts`), so "What did Maya say about the Lisbon budget?" needs every word in one doc. Dropping stop words and ORing the rest (`keywords`) takes full-coverage R@10 from 0.10 to 0.58, with no model at all.
2. **Coverage is the biggest gap.** With production coverage, even the best mode reaches only 0.21 hit@10, because most gold sources are mail, messages, notes, calendar and files. No ranking change can find them.
3. **Rule-based pre-filters help temporal (+0.10 R@10) and person (+0.06) questions, and MRR overall (+0.08).** They cost a little on exact questions when a guessed date or `from:` filter is wrong. The fallback to plain keywords only applies when there are no results, so a wrong but non-empty filter still costs recall.
4. **Paraphrase and cross-language questions** stay low with BM25 alone. That is the semantic arm's job (already built, off by default) and the cards' job (§3.6).

There is also no agent-facing tool over the main index. The agent finds things with `memory_search`, `sessions_search`, `search_files` (a literal substring scan) and live connector tools (`mail_search`, `notes_search`). So when the owner asks the agent "when does my flight leave?", the answer depends on which tool it happens to pick. §6 fixes this.

## 2. Coverage: source by source

Status today: **in** = in `search.sqlite`; **live** = searchable only through a live tool or a side index; **none** = not searchable.

| Source | Today | Where today | How to add it | Freshness |
| --- | --- | --- | --- | --- |
| Chats, messages, tasks, feed, ideas, goals | in | `compose/search-sources.ts`, `indexer.ts` | done | bus events |
| Library items | in | `libraryText` in `search-sources.ts` | done; also re-index on content change (the 60 s reconcile only adds and removes ids, so an edited file keeps stale text) | bus + reconcile by `updatedAt`/hash |
| Meeting and voice transcripts | in, via Library | `compose/speech.ts` | add speaker turns as chunks with timestamps, `kind: library`, `tags: ["transcript"]`, `from:` per speaker | on save |
| Research reports | in, via Library (untrusted) | `compose/research.ts` | also index the report's cited sources as child docs (`parentId` = report), so "where did I read that" works | on save |
| Documents and artifacts | in, via Library mirror | `artifacts/store.ts#mirror` | index the latest version only; tag `artifact`; re-index on each version | on version |
| Files in granted folders | live (`search_files`, substring scan) | `packages/files/src/tools.ts` | new `files` source: walk granted roots, extract with the existing extractors (PDF, DOCX, XLSX, text, Markdown), `kind: library`, `source: "files"`, `scopeKey` owner, `sourcePath` | FSEvents watcher + nightly sweep |
| PDFs and scans | text PDFs live on demand; scans **none** ("OCR is not available") | `files/src/extract/pdf.ts` | mac-helper OCR method (Apple Vision `VNRecognizeTextRequest`, `.accurate`, on-device, no model download): `ocr.recognize({ path, pages? })` → text per page. Run only when a PDF page has < 30 chars of text layer. | with the file |
| Screenshots and images | names and tags only | `compose/screen-ask.ts` | same Vision OCR for `image/*` Library items and granted-folder images; store recognised text as the body. Optional later: a one-line caption from the model the owner already uses, only when they opt in (cloud). | on add |
| Chat attachments | `has:attachment` flag only | `indexer.ts` | extract text like Library items, child doc with `parentId` = message | on message |
| Browser pages read | none (live `web.fetch`, not stored) | `compose/web-tools.ts` | "pages I read" source: when the agent or the owner (built-in browser) reads a page, store URL, title, readable text (cap 20 kB), `provenance: untrusted`, 90-day retention by default, one setting to turn off | on read |
| Mail | live (`mail_search`) | `connectors/src/apple/connector.ts` | connector cache → index via the existing `connectorDoc` adapter (no callers today): subject, from, to, date, body (quoted replies stripped), attachments as children | incremental by `ROWID`/date cursor, every 5 min |
| Messages (iMessage) | people graph only | `compose/people.ts` (psyche.sqlite) | index messages per conversation day as one doc (keeps the doc count sane), `from:` per sender | `chat.db` cursor |
| Notes | live (`notes_search`) | Apple connector | index note title and body | modified-date cursor |
| Calendar | none | – | EventKit via mac-helper: title, time, place, attendees, notes. Index the next 12 months and past 3 years. `createdAt` = start time, so dates filter by when it happens. | EventKit change notification + hourly |
| Reminders | none | – | EventKit reminders: title, due date, list, done state | same |
| Contacts | live | Apple connector | not indexed as docs; feeds the people graph (aliases, emails, phones) used by query understanding (§4.2) | daily |
| People graph | side index in `psyche.sqlite` | `compose/people.ts`, `graph.ts` | move `entityDoc`s into `search.sqlite` as `kind: person`, so one query covers people and their docs | on graph change |
| Memory | live through `MemoryStore` | `search/src/memory.ts` | keep live (memory has its own index); fused by RRF as today | – |
| Follow-ups | none | `proactive/src/daily/followups.ts` | index each detected follow-up as a small doc linked (`parentId`) to its source message | on detection |
| Audit log | none | `packages/audit` | index approvals and receipts as `kind: task`-group docs with `has:approval` / `has:receipt` ("what did Psyche send on my behalf last week?"). Owner-only, never in a delegated scope. | on append |

Connector caches follow the open question in `search-2026.md` §8 (opt-in per connector). This doc recommends **on by default for local sources** (Mail, Messages, Notes, Calendar, Reminders, granted folders), because the index never leaves the Mac, with a per-source switch in Settings → Search and an "Exclude" list (folders, mail accounts, chats).

### 2.1 Watchers versus scheduled reindexing

| Mechanism | Use for | Cost |
| --- | --- | --- |
| Bus events (today) | everything Psyche writes itself | free |
| FSEvents on granted roots (one stream, coalesced, 2 s latency) | files | one kernel stream, no polling; memory already uses `fs.watch` |
| Cursor polling (5 min) | Mail, Messages, Notes (their stores have no change feed Psyche can subscribe to without extra entitlements) | one small SQL query per source |
| EventKit `EKEventStoreChanged` | Calendar, Reminders | free |
| Nightly sweep (on power, idle) | every source: catch missed events, deletions, moved files | a few minutes of background IO |

The nightly sweep is the safety net and also the deletion check (§2.3). Backfill stays resumable with a cursor per source (`backfill.<source>` in `search_meta`).

### 2.2 Dedupe

- **Same item, two paths** (a PDF in a granted folder that was also added to the Library; a mail attachment saved to Downloads): content hash (SHA-256 of extracted text) in a new `search_docs.content_hash`; at query time, collapse equal hashes to the newest, best-provenance copy.
- **Mail threads**: strip quoted replies (`>` lines, "On … wrote:") before indexing, so a 20-message thread doesn't hold 20 copies of the first mail.
- **Near-duplicates** (newsletters, receipts): left to MMR at query time (§5.3), not removed at ingest.

### 2.3 Deletion propagation

Every connector doc stores `source` and its native id. Deletion paths:

1. Change feeds report deletes (FSEvents remove/rename, EventKit).
2. Cursor sources can't see deletes, so the nightly sweep lists native ids and removes the rest (`removeMissing(source, ids)`, the same set-difference the Library reconcile does).
3. Turning a source off calls `removeSource(source)` at once.
4. Revoking a folder grant removes every doc under that root.

Vectors, cards and chunks follow through the existing delete trigger on `search_docs`.

### 2.4 Storage growth (estimates for a heavy user)

| Source | Docs | Text indexed | FTS overhead | Vectors (e5-small, int8, ~1.5 chunks/doc) |
| --- | --- | --- | --- | --- |
| Mail (10 years, quotes stripped) | 60k | ~150 MB | ~150 MB | ~35 MB |
| Messages (by conversation-day) | 40k | ~40 MB | ~40 MB | ~25 MB |
| Notes, Calendar, Reminders | 15k | ~15 MB | ~15 MB | ~6 MB |
| Granted-folder files (cap 200 kB text each) | 20k | ~300 MB | ~300 MB | ~60 MB (64-chunk cap) |
| OCR text (scans, screenshots) | 5k | ~10 MB | ~10 MB | ~3 MB |
| Browser pages (90 days) | 5k | ~50 MB | ~50 MB | ~10 MB |
| **Total** | **~145k** | **~565 MB** | **~565 MB** | **~140 MB** |

So about 1.3 GB on disk for a very heavy home and 200–400 MB for a typical one. Disk is the cheaper resource for this owner; §8 keeps RAM flat as the index grows. Settings → Search shows the size per source with "Remove" per source.

### 2.5 Scope and taint at ingest

Every new source sets `provenance` as today: mail, messages, browser pages and downloads are `untrusted`; the owner's own notes, calendar, reminders and files are `owner`; Psyche's research and documents are `agent`. `scopeKey` is always `owner` for connector sources: a designated person's agent never sees the owner's mail.

### 2.6 Status: local sources landed

Mail, Messages, Notes, Calendar, Reminders and files in granted folders are indexed by `SourceIndexer` (`packages/search/src/sources/`), driven from the Gateway's existing 60 s timer (a step every 5th beat, nothing new always on). Each source is **off by default** (this supersedes the "on by default" recommendation above, per the owner's opt-in decision) and is switched in Settings → Search sources, with items, last indexed, size, Rebuild and a processing model per source (`cloud` | `local` | `none`; only `none`, no context cards, acts today).

- **Cursors:** Mail walks back by date, then follows new mail with `since`; Messages pages `messages.graph_read` (`includeText`) by ROWID, one doc per chat and day; Notes by modified date; Calendar by windows (3 y back, 12 months ahead); Reminders re-read whole (hash skips unchanged); files by (mtime, path) with an FSEvents watcher (`fs.watch` recursive, 2 s coalesced).
- **Sweep:** once a day, on power, each source with `listIds` removes what vanished (Messages has none: Rebuild drops deleted ones). A partial listing never deletes.
- **Dedupe:** SHA-256 of title and text per item (unchanged items are not rewritten); identical long text (>= 200 chars) in two sources keeps one, preferring the owner's copy.
- **Provenance:** other people's mail and any conversation-day with an inbound message are `untrusted`; the owner's sent mail and outbound-only days are `owner`; notes, events and reminders are `owner` only when the #1006 trusted-sources check says so (else `untrusted`); files under `Downloads` are `untrusted`, other granted-folder files `owner`.
- **Exclusions:** contacts (address, phone digits or name), chats, mail accounts and folders, stored with the source config in the `search.sources` setting; adding one purges what it matches at once. The everything-memory plan extends this list.
- **Battery:** low-power mode pauses everything; on battery only filled sources take one page per tick (no backfill, no sweep).
- **Kinds:** all of them are `connector` docs (`source: local:<id>`), files included (the roadmap said `library`; the Library reconcile and a full rebuild sweep that kind). Context cards reach them through the existing `CardQueue` scan.
- **Not done:** OCR (the mac-helper has no Vision capability; `ocr` is a hook on the files source, scans and images are indexed by name); Mail attachments as child docs; per-source people-graph resolution (§3.2).

## 3. Ingest quality

### 3.1 What a doc is

Small, meaningful units: one mail, one conversation-day of messages, one note, one event, one file (chunked). A doc carries `title`, `text`, `from`, `to` (new, for "emails I sent Daniel"), `createdAt` (for events, the start time), `source`, `sourceRef` (native id or path, for "show me the source").

### 3.2 Entities at ingest

Resolve senders and recipients to people-graph ids (`sender_key` already exists) so "from Maya" matches `maya@…`, "Maya Okafor" and her phone number.

### 3.3 Dates in text

Extract explicit dates and times from the body (flight times, due dates) into a `search_dates` side table (`doc_id`, `at`), so "what's happening on December 4" finds the flight mail sent in September.

### 3.4 OCR via mac-helper

Apple Vision runs on the Neural Engine/GPU with system models: no download, no resident model in Psyche's process, ~0.2–0.5 s per page on Apple Silicon, peak memory in the helper only while a page is recognised. A queue in the Gateway sends one page at a time, on power only for the backfill. Not a local LLM, so no warning to the owner is needed. Linux and Windows hosts skip OCR (a future Tesseract plug-in).

### 3.5 Chunking

Unchanged from `search-2026.md` §5.3 for vectors. Lexical keeps one row per doc.

### 3.6 Context cards and contextual chunks (owned by grounded-ingest)

The grounded-ingest work (#1007, merged) adds a short grounded card per doc (`search_cards`, with entities and dates in `search_card_entities` and `search_card_dates`) and prefixes later chunks of long docs with "title · source · date" before they are embedded. Card text goes into the FTS `extra` column and into its own vector chunk, and hits carry `RichHit.card`. This roadmap builds on it rather than repeating it:

- People and date pre-filters (§4.2, §4.3) can use `index.cards.docsForEntity()` and `docsForDates()`, which also cover §3.2 and §3.3 for docs that have a card.
- The harness can attach cards with `index.attachCard()` after indexing. Cards should lift paraphrase and cross-language recall most.

## 4. Query understanding

A question becomes **free text + pre-filters + intent**. Filters run first in both arms, as `type:` and `in:` do today.

### 4.1 Pipeline

1. **Typed syntax** (`from:`, `type:`, `after:` …) is parsed as today and always wins.
2. **Rules** (no model, < 1 ms): stop words, temporal phrases, source words, people. Prototype in `eval/rewrite.ts`, `rules` mode.
3. **Cheap model** (optional, for questions the rules don't settle): the router's cheapest bound model with a 150-token JSON schema `{ terms, after?, before?, people?, sources?, intent }`. Only for the Search screen's "Ask" mode and the agent tool, never for ⌘K keystrokes. Cached per normalised question.
4. **Fallback**: if the filtered query finds nothing, run again without the guessed filters and say so ("No results last week; showing all dates").

### 4.2 Temporal expressions

Rules for: today, yesterday, this/last/next week, weekend, month, last N days, last/next/this <weekday>, month names with "in/during/since", explicit dates. Evaluated in the owner's time zone (`tzOffsetMinutes`). Future phrases ("next Thursday") match event start times and extracted dates (§3.3), which is why `createdAt` for events is the start.

### 4.3 People

"Maya", "my sister", "Daniel's email" → people-graph lookup (names, aliases, relationship labels from `people-and-projects-2026.md`) → `sender_key IN (…)` **or** a mention boost (§5.2). "From" is strict (sender), "about" is a boost. Ambiguous names list the candidates as chips in the Search screen.

### 4.4 Sources and types

"email", "text", "note", "on my calendar", "pdf", "spreadsheet", "screenshot" → source and MIME filters. Needs one new filter, `source:` (`source:mail`), because `in:connectors` lumps every connector together.

### 4.5 Intent

| Intent | Example | Behaviour |
| --- | --- | --- |
| find | "the lease pdf" | ranked hits, open the best one |
| answer | "when does my flight leave?" | grounded answer with citations (§6) above the hits |
| list | "all of Biscuit's vet visits" | larger k (50), sort by date, no diversity cut, a count |

Rules: question words and "?" → answer; "all/every/list/how many" → list; otherwise find.

## 5. Ranking

### 5.1 Today

BM25 (title weight 3, body 1, extra 0.5) × recency boost (half-life 30 days), RRF (k = 60) with the semantic arm and memory.

### 5.2 Boosts (cheap, all in SQL or on the fused list)

| Signal | How | Why |
| --- | --- | --- |
| Recency | keep, but per intent: none for list, half-life 30 d for find, 7 d for "latest" | old items should still win when they are the only match |
| Importance | per-source priors: owner-written > agent > untrusted; starred mail, pinned notes, events with attendees; a learned click prior (a hit opened from search gets +1, decays) | promos and newsletters sink |
| Entity match | +x when the resolved person is sender/recipient/mentioned, +y when the project matches | "Maya" questions surface Maya's texts over mail that mentions her once |
| Date match | +z when an extracted date (§3.3) is inside the temporal filter | finds the flight mail by flight date |

Weights are tuned on the harness, not by hand.

### 5.3 MMR diversity

On the top 50 fused hits, maximal marginal relevance (λ = 0.7) with cosine between doc vectors (or title trigram Jaccard without vectors) removes runs of near-identical newsletters and receipts. Skipped for list intent.

### 5.4 Reranking (optional, owner-approved)

A cross-encoder over the top 30–50 reorders by reading query and passage together. It is the single largest quality step in most benchmarks, but it is **memory-heavy and must not be turned on without telling the owner first.** It is off by default, behind Settings → Search → "Rerank results", with the RAM cost stated in the toggle.

| Option | Size on disk | Resident RAM while loaded | Latency, 40 pairs × 256 tokens, M-series CPU | Languages | Licence |
| --- | --- | --- | --- | --- | --- |
| `ms-marco-MiniLM-L-6-v2` int8 | ~25 MB | ~150–250 MB | ~80–150 ms | English | Apache-2.0 |
| `mxbai-rerank-xsmall-v1` int8 | ~75 MB | ~300–400 MB | ~150–300 ms | mostly English | Apache-2.0 |
| `bge-reranker-v2-m3` int8 | ~570 MB | ~1.0–1.5 GB | ~1–3 s | multilingual | Apache-2.0 |
| Cloud rerank (Cohere Rerank 3.5, Voyage rerank-2.5-lite) | – | ~0 | ~150–400 ms network | multilingual | API; text leaves the Mac |
| Listwise rerank by the owner's cheap chat model (Haiku-class) | – | ~0 | ~0.5–1 s | multilingual | uses the existing provider; text leaves the Mac unless the model is local |

(Estimates; to be measured before the toggle ships.) Rules:

- Load lazily on first use and unload after 5 minutes idle, like the embedder, so resident RAM is zero when search is idle.
- Only for the Search screen's Enter and the agent tool, never ⌘K keystrokes.
- Cloud rerank follows the embedding privacy rule (`allowCloud` for rerank, off by default, owner-only snippets of at most 512 characters, never delegated-scope docs).
- Recommendation: **cloud or listwise rerank with the cheap model first** (no RAM), the MiniLM model as the local option, `bge-reranker-v2-m3` only if the owner asks for multilingual local reranking after seeing the RAM number.

## 6. Answers

### 6.1 One tool for the agent

Add `search_everything` (read-only, `operator.read` class, no approval): `{ query, after?, before?, people?, sources?, limit? }` → hits with `id`, `title`, `source`, `from`, `date`, a 400-character snippet, `provenance`. It runs the same `index.search` as the owner's Search screen with the owner viewer (or the delegated viewer in a designated-person thread). It replaces guessing between `search_files`, `mail_search` and `notes_search` for recall questions; the live tools stay for actions (reply, open).

### 6.2 Grounded synthesis

For answer intent (Search screen "Ask" and the agent):

1. Retrieve (filters → hybrid → boosts → MMR → optional rerank), top 8.
2. The model answers only from those sources with inline citations `[mail-012]`.
3. A cheap check: every cited id must be one of the 8 passed; a sentence without a citation is dropped or marked "not in your data".
4. If nothing relevant: say so and show the closest hits, never answer from model knowledge.

The harness's `--llm` mode measures citation precision and answer correctness with the cheap model.

### 6.3 Follow-ups and "show me the source"

- Each citation is a chip that opens the source in its pane (mail in Mail viewer, file in the viewer, event in Calendar) via `sourceRef`, with the cited passage highlighted.
- The answer card offers two or three follow-ups built from the hits ("Show all Lisbon emails", "When does Maya land?").
- A follow-up question reuses the previous filters unless it overrides them.

## 7. Privacy and taint through retrieval

- **Provenance travels with every hit** into the answer. If any cited source is `untrusted` (mail, messages, web pages), the turn is tainted exactly as reading that mail through `mail_search` would taint it (security §3.6): the answer can be shown, but tool calls that follow need approval as for any tainted turn.
- **Sources are data, never instructions**: retrieved text goes to the model inside `<source>` blocks with the standard untrusted wrapper.
- **Scope**: the delegated viewer filter applies to every arm (lexical, vector, cards, rerank). Connector docs are owner-scope only.
- **Off-device**: nothing leaves the Mac unless the owner enabled cloud embeddings, cloud rerank, or uses a cloud chat model for answers (which already sees what it is given). Settings → Search lists which of these are on.
- **Incognito** chats are never indexed. Turning off a source removes its docs at once (§2.3).
- **Audit-log docs** never reach a delegated viewer and are never sent to cloud rerank.

## 8. Performance budgets

| Budget | Target | Notes |
| --- | --- | --- |
| ⌘K keystroke (lexical, rules) | p95 < 60 ms at 150k docs | no model in the path |
| Search screen Enter (hybrid + boosts + MMR) | p95 < 250 ms | query embedding ~10 ms; vector scan see below |
| Ask (answer intent) | first token < 1.5 s, cloud cheap model | retrieval ≤ 300 ms of that |
| With local rerank | + 150 ms (MiniLM) / + 1–3 s (bge-m3) | only when enabled |
| **Resident RAM, idle** | **≤ 30 MB over today** | SQLite page cache capped at 16 MB for `search.sqlite`; embedder and reranker unloaded when idle |
| Resident RAM, during query | + vectors | int8 in-memory scan: 150k chunks × 384 = ~58 MB. Above 200k chunks switch to sqlite-vec on disk (ADR-004) instead of growing RAM. |
| Resident RAM, backfill | ≤ 150 MB peak | embedder ~120 MB loaded; OCR runs in mac-helper |
| Index size | ~1.3 GB heavy, 200–400 MB typical (§2.4) | disk is the cheaper resource for this owner |

RAM rule: when an option trades disk for RAM (in-memory vector copy vs sqlite-vec), choose disk once the RAM cost would exceed ~60 MB.

## 9. Eval harness

`packages/search/eval` (#1008; see its README):

- `fixtures/corpus.json`: a synthetic life of one owner, 425 docs across mail, iMessage, Notes, Calendar, Reminders, granted-folder files, Library items, chats and tasks, with hard negatives and a few Portuguese docs.
- `fixtures/questions.json`: 150 questions in eight classes (exact, paraphrase, temporal, person, list, multihop, crosslingual, filter) with gold source ids and answer keywords.
- `run.ts`: builds an in-memory index, runs each question in three modes (`raw`, `keywords`, `rules`) and two coverages (`production`, `full`), and reports recall@1/5/10/20, MRR, nDCG@10, zero-result rate and citation precision. `--llm` asks `claude-haiku-5-5` for grounded answers and scores citations and answer keywords.
- Run with `pnpm --filter @psyche/search eval`.

Every phase below must report its numbers from this harness in its PR. Gates: no class drops more than 0.02 R@10; the phase's target class rises.

## 10. Phased plan

Each row is one PR-sized step. Expected gains are rough, from the baseline in §1 and the per-class numbers in the harness; each PR measures its own.

| # | Step | Size | Expected gain |
| --- | --- | --- | --- |
| R1 | **Natural-language queries**: stop words + OR for free text when the input has ≥ 4 words or a "?", in `query-parser.ts`, ⌘K keeps prefix-AND for short input | S | largest single jump on `raw` (R@10 from near zero to the `keywords` row) |
| R2 | **`search_everything` agent tool** (§6.1) | S | the agent can finally use the index; enables R9 |
| R3 | **Mail, Notes, Messages into the index** via `connectorDoc` + cursor sync + sweep deletes, Settings per source | M | production coverage approaches full: the production→full gap in §1 |
| R4 | **Calendar and Reminders** through mac-helper EventKit | M | temporal and multihop questions about plans |
| R5 | **Granted-folder files** with FSEvents + extractors + content hash dedupe | M | file questions; dedupe keeps lists clean |
| R6 | **Rules query understanding** (temporal, source:, people via graph) with fallback | S | temporal and person classes (the `rules` row) |
| R7 | **Vision OCR** in mac-helper for scans and screenshots | M | "find the receipt screenshot", scanned leases |
| R8 | **Boosts + MMR** tuned on the harness | S | MRR and nDCG, fewer newsletter runs |
| R9 | **Grounded answers** with citations, follow-ups, source chips; taint propagation | M | answer intent end to end; citation precision tracked |
| R10 | **Turn on the semantic arm by default** (after the owner's OK on the ~120 MB download and ~150 MB backfill peak) , measured together with the #1007 cards | S | paraphrase and crosslingual classes |
| R11 | Browser pages, transcripts by speaker, attachments, follow-ups, audit docs | M | long-tail "where did I see…" |
| R12 | **Optional rerank** (cloud/listwise first, MiniLM local), owner-approved | M | top-1 precision; measured before shipping |
| R13 | Cheap-model query parsing for Ask, cached | S | the rules' misses on temporal/person |

Order: R1, R2, R6 are small and need no new data; R3–R5 are the coverage work; R9 needs R2; R10 waits for the owner's OK ; R12 waits for an explicit owner OK on RAM or cloud.

## 11. Open questions for the owner

1. **Local sources on by default** (Mail, Messages, Notes, Calendar, Reminders, granted folders), with per-source off switches? Recommended yes, since the index stays on the Mac.
2. **Browser history of pages read**: keep 90 days by default, or off by default?
3. **Reranking**: cloud or cheap-model listwise (no RAM, text leaves the Mac) versus local MiniLM (~200 MB while loaded, English) versus none.
4. **Semantic arm on by default** now that #1007 cards have landed (~120 MB download, ~150 MB peak while indexing, ~60 MB during queries at 150k chunks)?
