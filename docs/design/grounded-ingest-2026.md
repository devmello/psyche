# Grounded ingest: context cards (2026-10)

Goal: search as "a searchable version of your life you can prompt in English". At ingest, a cheap model writes a **context card** for each item; the card is indexed with the item.

## Audit (before)
- `memory` / `remember` tools append to daily notes (`packages/memory`); USER.md learning (#959) and agent self-notes (#977) write workspace files. Memory is searched through `MemoryStore` (chunks, BM25 + vectors), not `search_docs`.
- `packages/search`: `search_docs` + external-content FTS5 (`title, body, extra`), optional on-device embeddings (`SemanticIndex`, chunks of 1200 chars, RRF fusion). Producers: chat events (`SearchIndexer`), backfill sources, Library sync, connector caches, people graph.
- Gaps: a long document's later chunks lost their title/source/date; nothing described *what an item is about* in the words people ask with; no entity/date columns.

## What it does
- `packages/search/src/cards/`: `generateCard` (one tool-less call, `toolChoice: none`, source inside `<data>`), `validateCard`, `CardStore` (`search_cards`, `search_card_entities`, `search_card_dates`, `search_card_queue`), `CardQueue`, `syncMemoryNotes`.
- **No hallucination.** Every claim has `quote`, `[start,end)` offsets into the source and a `confidence`. Validation drops a claim when the quote is not in the source (case/whitespace tolerant), the value is not inside its quote, or it contains a number the source lacks. Resolved values (a date "next Friday" → ISO) must be marked `derived` with a `basis`, otherwise the ISO is dropped. A card without a grounded title and summary is discarded.
- **Taint.** The card inherits the source's provenance (least trusted for memory notes); untrusted sources cap confidence at 0.6 and the source is wrapped as data. A card is stored on the document row's scope, so delegated viewers and incognito rules apply unchanged; deleting the document deletes the card.
- **Indexing.** Card text (title, summary, why, questions, entities, places, dates, tags) goes into the FTS `extra` column and is embedded as its own chunk; entity and date tables allow filtering (`cards.docsForEntity`, `docsForDates`). Hits carry `card { summary, span, questions, confidence }` (protocol `SearchHitCard`), shown in the Search detail pane.
- **Contextual chunks.** Chunks after the first of a long document are prefixed `title · source · date` before embedding.
- **Cost.** Haiku-class utility role via the existing provider. `CardQueue.tick()` runs inside the existing 60 s library-sync timer: queues new items, backfills 5 existing ones per tick (newest first, only when the queue is empty), generates 3 per tick, stops at a daily token budget (`search.cards.dailyTokenBudget`, default 200 000), and does nothing when `search.cards.enabled` is false. Source text is capped at 6 000 chars. No local model, no new process.
- **Memory tool guidance.** `remember` and `memory` descriptions ask for who/what/when (calendar date)/where/why, only what was said, inferences marked.

## Estimated cost per item
About 1.4k input tokens (system prompt ~600 + capped source) and ~500 output tokens, so ~1.9k tokens. At an assumed Haiku-class price of $1/M in and $5/M out, about $0.004 per card; the default daily budget bounds spend to roughly $0.40/day.
