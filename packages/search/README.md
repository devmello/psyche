# @psyche/search

**Owner:** S16 (`prompts/s16-search-skills.md`). Feature ids: S1 (S2 is M2) in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

One index over everything the owner and the agent produced: threads and messages, tasks and their Activity lines, Library items (with extracted text), feed posts, ideas, goals and the connector caches the owner opted to index. Memory is searched live through `MemoryStore` and fused into the results. It serves the Search screen and ⌘K (UI §3.13, §2.5) and the `search.query` method.

## Public API

```ts
import { createSearchIndex, SearchIndexer, createSearchHandlers } from "@psyche/search";

const index = createSearchIndex({ path: `${home}/state/search.sqlite`, memory }); // SqliteSearchIndex
const indexer = new SearchIndexer(index, { lookupThread, senderOf, onError });
bus.on("*", (event, payload) => indexer.handle(event, payload));
const handlers = createSearchHandlers(index); // { "search.query": (params, { viewer }) => … }
```

- `SqliteSearchIndex` implements the `SearchIndex` contract (`index`, `remove`, `query`) and adds:
  - `search({ q, viewer?, limit?, groupLimit?, groups?, kinds?, collapse? })` → `{ hits, groups, total, warnings, tookMs }`: hits collapsed (messages onto their thread, task actions onto their task), grouped by pane in UI order (`threads, tasks, memory, library, feed, ideas, goals, connectors`) with per-group counts, plain snippets plus `[start, end)` highlight ranges for snippet and title, provenance on every hit;
  - `indexMany(docs)` (one transaction), `removeThread(id)`, `removeSource(source)`, `retitleThread(id, title, scopeKey)`, `setFlag(targetId, "approval" | "receipt" | "attachment")`, `count()`, `optimize()`.
- `SearchDoc` = the contract's `SearchIndexDoc` plus optional `scopeKey`, `parentId`, `source` (proposed for the contract in a `protocol:` PR).
- Adapters (pure): `threadDoc`, `messageDoc`, `blocksText`, `taskDoc`, `taskActionDoc`, `libraryDoc(item, extractedText)`, `feedDoc`, `ideaDoc`, `goalDoc`, `connectorDoc(connectorId, item)`.
- `SearchIndexer.handle(event, payload)`: `thread.updated`, `thread.deleted`, `chat.message`, `task.updated`, `task.action`, `approval.created`, `receipt.created`, `feed.post`, `feed.updated`, `idea.updated`, `goal.updated`. Errors go to `onError` instead of the event bus.
- `parseQuery`, `toFtsMatch`, `toFtsExclusion`, `fuse` (reciprocal rank fusion), `routeOf(hit)` (UI §2.7 deep links).

## Query syntax

| Syntax | Meaning |
| --- | --- |
| `dentist booking` | both words; **every word of three or more letters matches as a prefix** (`runni` → running), with a light plural fold (`dentists` → `dentist*`, `parties` → `part*`); diacritics folded |
| `"three slots"` | exact phrase (no prefix) |
| `dentist alice OR bob` | `dentist AND (alice OR bob)`: an OR chain binds tighter than AND |
| `-cancelled` | exclude |
| `in:threads` `in:tasks` / `in:activity` `in:memory` `in:library` / `in:files` `in:feed` `in:ideas` `in:goals` `in:connectors` `in:messages` | pane (document kinds) |
| `type:pdf` `type:image` `type:doc` `type:sheet` `type:slides` `type:audio` `type:video` `type:md` `type:text` `type:application/zip` | file type (MIME family); a kind name (`type:task`) also works |
| `from:alice` | sender contains `alice` (Unicode case-insensitive; name or address); quoted values allowed: `from:"Alice Chen"`, `from:émile` |
| `after:2026-09-01` `before:2026-10-01` `on:2026-10-02` `on:2026-10` | creation date; `after:` inclusive, `before:` exclusive, `on:` a day or a whole month; also `today`, `yesterday`, `7d`, `2w`, `3m`, `1y`; impossible dates are rejected |
| `has:approval` `has:receipt` `has:attachment` | the document carries that fact (a flagged thread or task matches itself; actions of a flagged task match too) |
| `is:owner` `is:agent` `is:untrusted` `is:system` | provenance |
| `thread:<id>` | inside one thread |

Unknown `key:value` tokens are searched as text and returned in `warnings`; negated filters (`-in:tasks`) are not supported and are returned in `warnings` without being applied. Input with nothing searchable left (`"`, `OR`, punctuation) matches nothing. User input never becomes FTS5 syntax: every token is quoted, punctuation splits tokens like the tokenizer does, and a query of only punctuation matches nothing.

## Ranking

`score = BM25(title ×3, body ×1, sender/tags ×0.5) × (1 + 1.0 × 0.5^(age / 30 days))`, computed inline in SQL: a document from today gets up to twice the score of an equally relevant one from last year (half-life and weight are options). Filter-only queries (`in:library type:pdf`) list newest first. In grouped results the flat list fuses the local ranking with memory hits by reciprocal rank fusion (k = 60), so the two scorers never need comparable scales.

Ranking runs in two steps: every match is scored once into a `TEMP` table (collapsing in SQL), then top-N slices are read per group and for the flat list, and snippets are built only for the rows returned. On 100 000 documents a term matching 70 % of the corpus answers in about 130 ms on an M-series laptop, three common prefixes in about 260 ms, rare terms and filtered queries in under 40 ms (`test/perf.test.ts`, `PSYCHE_PERF_LOG=1` prints timings).

## Permissions and privacy

- **Incognito content is never stored.** Indexing a document with `incognito: true` deletes any existing row with that id; a thread that becomes incognito is removed with its messages, tasks, actions and flags; messages and tasks of incognito threads are skipped. The indexer **fails closed**: a message, task or action whose thread (or task) it cannot resolve through the cache, `lookupThread` or `lookupTask` is not indexed.
- **Designated-person scoping.** Threads with a persona overlay (architecture §4.10) carry their session key as `scopeKey`; messages, tasks and actions inherit it. The owner (any paired operator device) sees every scope. A delegated viewer (`{ kind: "delegated", scopeKey }`, e.g. the agent answering a designated person) sees only its own scope and never memory.
- **Provenance travels with every hit**, so the UI can show the chip and an agent-side caller can taint the turn for `untrusted` hits. Feed posts and connector content are `untrusted`; downloads, connector and channel files in the Library are `untrusted`.
- **Memory is not copied.** `MemoryStore.search` is queried per request, so `forget` and dreaming are reflected immediately. Filters memory chunks cannot satisfy (`from:`, `has:`, `type:`, `thread:`) drop memory instead of being ignored.

## Storage

The index is derived data in its own file, `$PSYCHE_HOME/state/search.sqlite`, opened with `@psyche/db`'s hardened `openDb` (0700 directory, 0600 file, WAL) and a self-managed schema (`search_meta`, `search_docs`, `search_fts` external-content FTS5 with triggers, `search_flags`). It is not in `psyche.sqlite` because it can be deleted and rebuilt at any time and its frequent writes should not contend with the transcript writer; `docs/02-architecture.md` §12 lists it. Pass `db` to use another connection.

## Semantic search (S3, optional, on-device)

See [docs/design/search-2026.md](../../docs/design/search-2026.md).

- `SemanticIndex(db, options)` keeps chunk embeddings in the index file:
  - `search_vectors` holds unit float32 vectors with the model id and dims, plus the chunk text for snippets;
  - `search_vec_state` records the embedded version per document and model;
  - a delete trigger on `search_docs` drops a document's vectors with it.
- `setEmbedder(e)` embeds what is missing in the background (newest first, batches of 16, paced). Switching model re-embeds, then drops the old model's rows. `clear()` drops everything.
- Queries scan an in-memory int8 copy of the active model's vectors exactly.
- `SqliteSearchIndex.setSemantic(s)` fuses candidates into `search` by reciprocal rank (k = 60):
  - semantic candidates pass the same SQL filters as lexical rows (viewer `scopeKey`, `in:`, dates, `-excluded`);
  - with collapsing, a semantic hit on a message joins its thread's result;
  - hits carry `match` (`lexical`, `semantic` or `both`);
  - a semantic-only hit's snippet is its best chunk, with any literal query words marked;
  - a query whose embedding misses `queryTimeoutMs` (300 ms) runs lexically with the warning `semantic_busy`.
- `chunksOf(kind, title, body)`:
  - texts under 24 characters are not embedded;
  - texts up to 1,500 characters get one chunk;
  - longer texts get 1,200-character windows with 200 characters of overlap, at most 16 chunks (64 for Library items).
- `createOnnxEmbedder({ spec, modelPath, tokenizerPath })` is the built-in engine:
  - it runs on `onnxruntime-node`, CPU only, with 2 threads, and tokenizes with `@huggingface/tokenizers`;
  - both are imported lazily, only when semantic search is on;
  - a waiting query goes before waiting document batches.
- `EMBEDDING_MODELS` pins `multilingual-e5-small` (int8, 118 MB, MIT) to a Hugging Face revision and SHA-256. The Gateway downloads it with `@psyche/speech`'s `ModelManager` on first enable.
- `fakeEmbedder(groups)` is a deterministic concept-count embedder for tests. No test downloads or runs a real model.

## Web tools: `web.search` and `web.fetch` (#557)

Built-in agent tools, registered by the Gateway on every surface (desktop, web client, channels), so the agent can look up current facts without the desktop browser.

| Tool | Does | Policy |
| --- | --- | --- |
| `web.search {query, count?}` | top results: title, URL, snippet (and date when known) | `sideEffect: read`, no target (the provider is fixed by settings, never by the model): allowed in balanced and auto, hidden in plan mode |
| `web.fetch {url, maxChars?}` | a page's title and readable text (Markdown), 20 000 characters by default, 100 000 at most | `read` with the page's origin as target, so the broker's new-origin and sensitive-host rules apply; redirects must stay on the same origin; no cookies; private, loopback and link-local addresses refused (`safeFetch` from `@psyche/connectors`) |

Both return `untrusted` output: search results and page text taint the turn like any web content (security §7.2).

**Providers** (`search.web.provider`: `auto` default, `brave`, `searxng`, `duckduckgo`, `off`). `auto` uses, in order:

1. **Brave Search API** when `PSYCHE_SEARCH_BRAVE_KEY` is set. The key is masked in Gateway logs and only ever leaves in Brave's `X-Subscription-Token` header.
2. **SearXNG** at `search.web.searxngUrl` (the owner's instance; a LAN address is allowed for that one host:port; JSON format must be enabled).
3. **DuckDuckGo's HTML endpoint** (`html.duckduckgo.com/html/`, no key): requests at least 2 s apart, at most 20 per 10 minutes, and a 15-minute pause if DuckDuckGo answers with its bot check. Psyche never solves CAPTCHAs; the error tells the owner to configure Brave or SearXNG.

An explicit choice that is not configured falls back like `auto` and says so. The Gateway writes the read-only `search.web.status` setting (`{preference, active, brave, searxngUrl, note}`), shown in Settings → Model & providers → Web search together with the provider picker and the SearXNG URL field.

API: `createWebTools({provider, offReason?, fetchOptions?, fetchPage?})`, `braveSearch`, `duckDuckGoSearch`, `parseDuckDuckGoHtml`, `RateLimiter`, `webSearchStatus`, `providerFor`, `parsePreference`, `parseSearxngUrl`; Gateway side `composeWebTools` in `apps/gateway/src/compose/web-tools.ts`.

Tests: provider parsing against recorded DuckDuckGo and Brave responses, the rate limiter and bot-check backoff, provider selection, `web.fetch` through the real `safeFetch` with a fake network (same-origin redirects, private addresses, size cap); a Gateway scenario answering "current Node.js LTS" through both tools on recorded pages; a live gate (`apps/gateway/test/web-tools.live.test.ts`, `PSYCHE_LIVE_TESTS=1`, Haiku by default).

## How this maps to the docs

- Architecture §4.12 (one index, typed filters, results open their pane), §4.10 (designated persons), §4.8 (memory index and provenance), §12 (storage).
- Feature S1 ("sub-second results on a year of data": 100k-document test).
- UI §3.13 (grouped results, provenance chip for memory), §2.7 (routes), §2.5 (⌘K).

## What is stubbed

- The Gateway composes the main index in `apps/gateway/src/compose/search.ts` (S1 of [docs/design/search-2026.md](../../docs/design/search-2026.md)): `state/search.sqlite`, the indexer on every bus event (one ordered queue), and `search.query` for the owner. Hits carry kind, group, provenance, `createdAt` and highlight ranges; the result carries `groups`, `total` and `warnings`.
- Library text extraction (S13) and connector cache feeds (S09) call `libraryDoc` / `connectorDoc` themselves; there are no events for them yet. Connector opt-in is the caller's decision; `removeSource("connector:<id>")` drops a connector the owner stops indexing.
- `Backfill(index, sources, options)` (S2): resumable, throttled pass over `BackfillSource`s (cursor per source in `search_meta`, `needed()` until `BACKFILL_VERSION` ran); `start({ full: true })` rebuilds and sweeps rows whose store row is gone (only rows from before the run, only the sources' kinds). The Gateway's sources are in `apps/gateway/src/compose/search-sources.ts`; `search.status`, `search.reindex` and `search.status.updated` report and drive it. Library items have no events: the Gateway reconciles them every minute.
- `sessions_search` for the agent (S2) is M2.
