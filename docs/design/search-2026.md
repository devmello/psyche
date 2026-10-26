# Search 2026: hybrid on-device search

Status: plan and spec. Phases S1–S2 are being built first, then S3. This extends feature S1/S2 (`docs/03-feature-spec.md`), architecture §4.12, UI §3.13 (Search screen) and §2.5 (⌘K). Implementation lives in `packages/search` and in `apps/gateway/src/compose/search.ts`.

## 1. Problem

The Search screen and ⌘K both answer with "Search failed (search.query is not implemented yet)."

`packages/search` already has a complete lexical engine:

- an FTS5 index with BM25, recency boost and collapsing;
- a query language (`in:`, `from:`, `type:`, dates, `has:`, `is:`);
- highlights, viewer scopes, and the event-driven `SearchIndexer`;
- `createSearchHandlers`.

The Gateway never composes any of it. It only uses `SqliteSearchIndex` for side indexes (other-chats digests, people-graph docs, both inside `psyche.sqlite`). So:

- no main index exists;
- nothing feeds it;
- `search.query` has no handler, so the dispatcher throws `not_implemented`.

The owner also asked whether search should be semantic (embeddings) or plain text. If semantic, it should run on-device, with an online embedding provider only as an opt-in.

## 2. Decision: hybrid, with lexical as the backbone

**Recommendation (confirmed after research): FTS5/BM25 stays the backbone and always runs. Semantic search is an optional second retriever. The two are fused with reciprocal rank fusion (RRF, k = 60), which `fuse()` already implements.**

Why lexical first:

- **Personal queries are mostly exact.** Names ("Maya"), places, ids, URLs, file names, dates and quoted phrases. BM25 wins these outright, and embeddings are known to blur them.
- **Lexical needs no model and no backfill.** It is instant to index, cheap on battery, and works on every OS.
- **The filter language already works** (`from:`, `type:`, `has:`, dates). It only makes sense over the lexical index.
- **Deletes are exact.** Incognito removal, `thread.deleted` and connector opt-out hold without approximate structures.

Why add semantic:

- It finds paraphrases ("the trip budget" → "how much we can spend in Lisbon").
- It works across languages: a French note matches an English query with a multilingual model.
- It catches vocabulary mismatch that prefix matching can't.

Why RRF rather than score blending:

- BM25 and cosine are on incomparable scales.
- RRF uses ranks only, so neither side needs calibration, and memory hits already fuse this way.
- The vector arm can't flood results: it contributes only hits above a cosine floor (§5.8). Lexical ranks keep at least equal weight.

**Refuted alternatives:**

- **Semantic only.** It loses exact match and filters, and needs a model on day one.
- **A separate vector database** (Qdrant, LanceDB, hnswlib). It adds a second store to keep consistent with deletes, plus a native dependency per OS. At personal scale (≤ ~200k vectors), exact search in SQLite is fast enough (§5.10).

## 3. Engines (who turns text into vectors)

There is one interface, already defined by `@psyche/memory`: `Embedder { model, embed(texts, "document" | "query") }`. Search and memory share it, so turning semantic on also gives memory vectors.

The settings are `search.semantic.enabled`, `search.semantic.engine` (`builtin` | `router`), `search.semantic.model` and, from S4, `search.semantic.allowCloud`. Everything is off by default. They are under Settings → Model & providers → Search, next to Web search.

| Engine | What | When |
| --- | --- | --- |
| **builtin** (default when enabled) | An ONNX model run in-process. Runtime: `@huggingface/transformers` on `onnxruntime-node`, on CPU, in a worker thread. | Nothing else to install. This is "Semantic search (on-device)". |
| **router**, local provider | The model-router's `embedding` role bound to Ollama, LM Studio, llama.cpp or another OpenAI-compatible local server (`isLocalKind`). | The owner already runs one. Bigger models such as `bge-m3` or `qwen3-embedding` live here. |
| **router**, cloud provider | The same role bound to OpenAI (`text-embedding-3-small` at 512 dimensions), Voyage (`voyage-3.5-lite`) and similar. The key comes from the vault through the router. | Only with `allowCloud: true`, set by the owner in Settings after a warning. |

### Default built-in model: `multilingual-e5-small`

| Property | Value |
| --- | --- |
| Size | 118M params, ~120 MB int8 ONNX |
| Dimensions | 384 |
| Input | 512 tokens |
| Languages | ~100 |
| Licence | MIT |

Alternatives in the catalog, since the owner may pick them:

- `bge-small-en-v1.5` (MIT, English, ~34 MB int8). Fastest.
- `EmbeddingGemma-300m`. Best small multilingual quality, but 5–10× slower and under the Gemma licence, so it is not the default.

Rejected:

- **jina v3/v4**: CC-BY-NC.
- **Qwen3-Embedding-0.6B in-process**: too slow for a 100k-chunk backfill on a laptop. It is offered through Ollama instead.

Throughput (estimates, to be benchmarked in S5):

| Workload | Estimate |
| --- | --- |
| 12-layer 384-dim model, 2 CPU threads, 256 tokens | ~15–40 chunks/s, so a 100k-chunk backfill takes about 1–2 h in the background |
| One query embedding | 5–20 ms |

### Download policy

The built-in engine follows the same policy as `@psyche/speech` `ModelManager`:

- Nothing downloads until the owner enables semantic search.
- Files are pinned to an HTTPS URL plus SHA-256, streamed to `.part` and renamed only once verified.
- They live under `$PSYCHE_HOME/models/embeddings/` with mode 0700/0600.
- Progress is reported through `search.status`.

### Privacy rule (hard)

Text is sent off-device only when two conditions hold:

1. `allowCloud` is true.
2. The bound embedding provider is not a local kind.

Otherwise the router engine refuses (`forbidden`) and semantic search reports `blocked: "cloud_not_allowed"`. Untrusted content (feed, connectors, downloads) is embedded like everything else, because the engine is local by default. With cloud allowed, Settings states plainly that chats, tasks and library text are sent to the provider.

## 4. Storage

Everything lives in `$PSYCHE_HOME/state/search.sqlite`: derived data that is safe to delete and rebuild, in its own file so its writes never contend with the transcript writer.

| Table | Content |
| --- | --- |
| `search_docs`, `search_fts`, `search_flags`, `search_meta` | existing lexical index |
| `search_vectors` (new) | `id` (`<docId>#<n>@<model>`), `doc_id`, `chunk` (n), `model`, `dims`, `text` (the chunk, for snippets), `embedding` (unit float32 BLOB, the source of truth) |
| `search_vec_state` (new) | `doc_id`, `model`, `version`: which version of each document a model embedded, so edits re-embed and unchanged documents never do |

A trigger on `search_docs` deletes a document's vectors and state with the document, whatever deletes it: a deleted thread, incognito, a dropped connector, a rebuild's sweep.

**As built (S3): an exact scan, no vector extension.** Queries scan an in-memory int8 copy of the active model's vectors. At 100k chunks × 384 dimensions that is about 38 MB of RAM and a few tens of ms per query. Reasons:

- It avoids loading sqlite-vec into a second database file.
- It avoids a vec0 table that would have to be rebuilt whenever the width changes.
- Every candidate still goes through the same SQL filters as lexical rows.

A sqlite-vec `vec0` mirror, like memory's (ADR-004, `packages/memory/src/vector.ts`), stays an S5 option if measurements on large homes need it.

Every vector row stores `model` and `dims`. A query uses only vectors of the active model. Switching model starts a re-embed while lexical keeps serving, and old-model rows are deleted once the new pass completes.

Index size at 100k chunks × 384 dimensions:

- float32: ~155 MB;
- int8: ~40 MB (S5 option).

The lexical index adds roughly the text size again.

## 5. Difficulties and how each is handled

### 5.1 First-run backfill

The index file is new on first run, and on upgrade the docs predate the indexer. A backfill job pages through every store in a fixed order:

1. threads;
2. messages, per thread;
3. tasks and task actions;
4. library (with extracted text);
5. feed, ideas, goals.

It calls `indexMany` with batches of 200 and yields to the event loop between batches (`setImmediate` plus a small sleep), so chat stays responsive.

A cursor per source in `search_meta` (`backfill.<source>`) makes the job resumable after a crash or quit. A `backfill.version` bump forces a full pass when adapters change.

Lexical backfill is fast (~10k docs/s). The semantic pass runs afterwards, separately and much slower (§5.11).

### 5.2 Incremental updates and deletes

`SearchIndexer` subscribes to every bus event and processes them in a single ordered queue, so a thread is always indexed before its messages:

- edits re-index;
- `thread.deleted` removes the thread with its messages, tasks and actions;
- a thread turning incognito does the same;
- connector opt-out uses `removeSource`.

Vector rows are keyed by `doc_id`. Removing a doc removes its vectors in the same transaction, and a changed doc is re-chunked only if its text hash changed.

### 5.3 Chunking

| Content | How it is embedded |
| --- | --- |
| Messages, tasks, ideas, goals, feed posts | One vector each: title + text, capped at ~1,500 characters (about 400 tokens). |
| Messages under 24 characters ("ok", "thanks") | Not embedded; lexical search still has them. |
| Library documents and long messages | Chunks of ~1,200 characters with 200 characters of overlap, split on paragraph boundaries. At most 64 chunks per doc (the rest stays lexical). |

Hits collapse to the best chunk per doc, then to the thread or task, before fusion.

### 5.4 Multilingual content

- The FTS5 tokenizer is `unicode61` with diacritics removed, which works for any space-separated language. CJK gets no word segmentation: the semantic arm covers it, and a trigram fallback is an S5 item.
- The default multilingual model handles cross-language queries.

### 5.5 Query and passage prefixes

Each catalog model carries its prefixes, for example e5's `query: ` / `passage: ` and nomic's `search_query: `. The router already adds the nomic prefixes. A prefix change counts as a model change (§4).

### 5.6 Viewer scope and untrusted content

Vector hits are joined back to `search_docs` before they leave the index, so the same rules apply as for lexical hits:

- the `scopeKey` filter: a delegated viewer sees only its own scope, never memory;
- incognito exclusion;
- provenance.

A semantic-only hit can therefore never reveal an owner-only doc to a designated person's agent. Every hit carries provenance, and agent-side callers taint the turn for `untrusted` hits.

### 5.7 What gets indexed

Indexed:

- the owner's threads and messages, tasks and actions;
- library items;
- feed, ideas, goals.

Connector caches are indexed only for connectors the owner opted into (`search.connectors`). Incognito is never stored. Memory is not copied: it is searched live, as today.

### 5.8 Ranking and snippets for semantic hits

- **Junk control.** The vector arm takes the top 50 by cosine, drops anything below the model's floor (e5-small: 0.80, bge-small: 0.55; calibrated in S5) and is skipped for queries under 3 characters.
- **Filters.** They are applied first, so `type:pdf budget` searches only PDFs in both arms.
- **Fusion.** The lexical and vector lists are fused by RRF, with the lexical list's weight ≥ the vector list's.
- **Snippets.** A hit that only the vector arm found has no FTS match to highlight. Its snippet is the best chunk's opening (trimmed to a sentence), with literal query words highlighted if any occur.
- **Labelling.** The hit carries `match: "semantic"`, and the UI shows a subtle "Related" label instead of bold terms.

### 5.9 ⌘K latency budget

⌘K must answer in under 150 ms at p95 on 100k docs. Measured lexical costs are 40–260 ms on 100k docs (`perf.test.ts`); semantic estimates are below.

| Step | Cost |
| --- | --- |
| Lexical | under 40 ms for typical palette queries |
| Query embedding | ~10 ms |
| KNN, 100k × 384 | ~15–70 ms |

Two rules keep ⌘K inside the budget:

- The palette debounces input at 120 ms and searches lexically first. The semantic arm runs only once the query has ≥ 3 characters and ≥ 1 complete word.
- The Search screen, where the owner pressed Enter or paused, always runs hybrid. If the embedder is busy with the backfill, the query waits at most 150 ms and then falls back to lexical, with `warnings: ["semantic_busy"]`.

### 5.10 Battery and CPU

- The built-in engine runs in a worker thread with `intraOpNumThreads = 2`.
- The backfill embeds in batches of 16 and sleeps between batches.
- It pauses while the Mac is on battery below 30 % or under thermal pressure (reported by the desktop shell), and resumes on power.
- Query embeddings always go first: the backfill queue yields to them.

### 5.11 Re-embedding

Changing the model or its prefixes doesn't migrate anything. The old vectors keep serving until the new pass completes, then old rows are deleted. The status shows "Re-indexing with <model>: 42 %".

## 6. Protocol

`search.query` stays as it is. Its result already has `groups`, `total` and `warnings`, and hits already carry `kind`, `group`, `provenance`, `createdAt` and highlight ranges. S3 adds an optional `match` field on hits (`lexical` | `semantic` | `both`).

New methods:

**`search.status`** (`operator.read`) returns:

- `docs` and `vectors` counts;
- `backfill`: `{ state: idle | running | paused | done, done, total, source? }`;
- `semantic`:
  - `enabled` and `engine`;
  - `model` and `dims`;
  - `state`: off | downloading | indexing | ready | error | blocked;
  - `progress`;
  - `error`.

**`search.reindex`** (`operator.write`, side-effecting) takes `{ semantic?: boolean }` and returns `{ started }`. It rebuilds the lexical index, re-embeds when `semantic` is true, and is idempotent while a run is in flight.

Event: `search.status.updated` carries the status payload, so Settings and the Search screen update live.

Every nested object gets an `$id`, so Swift codegen doesn't emit stdlib names.

## 7. Phases and acceptance criteria

| Phase | Scope | Accepted when |
| --- | --- | --- |
| **S1: wire FTS end to end** | `composeSearch`: index at `state/search.sqlite`, `SearchIndexer` on the bus, `search.query` with owner viewer, richer wire hits (kind, group, provenance, highlights, groups, warnings). | A new chat is findable from the Search screen and ⌘K. A deleted thread disappears. A gateway test covers the round trip and delegated scope filtering. |
| **S2: backfill, status, reindex** | Resumable, throttled backfill over every store. `search.status`, `search.reindex`, `search.status.updated`. Library items are indexed on add and remove. The Search screen shows "Indexing… n of m" and offers "Rebuild index" in the failure card and in Settings → Search. | On an existing home, old chats are found after one start. Killing the Gateway mid-backfill resumes from the cursor. Reindex runs once even when clicked twice. |
| **S3: local semantic** | `search_vectors` plus the sqlite-vec mirror, the chunker, the built-in ONNX engine (worker thread, download on enable with progress), the router engine (local kinds only), hybrid RRF in `SqliteSearchIndex.search`, `match` on hits, Settings → Search → "Semantic search (on-device)". | With a fake embedder, a paraphrase query finds a doc that has no shared words. A delegated viewer never gets another scope's semantic hit. Disabling semantic search drops vectors. No test downloads or runs a real model. |
| **S4: online provider** | `allowCloud` with a warning dialog, routing to a cloud-kind `embedding` binding through the router (key from the vault), and a per-model dimension option. | Cloud embeddings never run without `allowCloud`, which a test asserts. Switching between cloud and local re-embeds without serving mixed vectors. |
| **S5: tuning and evals** | A small labelled eval set from fixtures (recall@10, MRR, lexical vs hybrid), cosine floor calibration, int8 vectors, a CJK trigram fallback, perf tests for hybrid at 100k. | Hybrid recall@10 is at least lexical's on every query class, and better on paraphrase queries. p95 for ⌘K is under 150 ms at 100k docs. |

## 8. Open questions for the owner

1. **Default model:** multilingual-e5-small (multilingual, ~120 MB) or bge-small-en (English only, ~34 MB, faster)? The plan assumes multilingual.
2. **Connectors:** should connector caches (mail, notes) be searchable by default once connected, or opt-in per connector? The plan assumes opt-in.
