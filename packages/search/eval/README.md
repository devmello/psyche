# Search eval

A labelled benchmark for `@psyche/search` (plan: `docs/design/search-roadmap-2026.md` §9). It runs offline: BM25 only, no embedder, no network, unless you pass `--llm`.

```bash
pnpm --filter @psyche/search eval
```

## What it does

1. Loads `fixtures/corpus.json`: a synthetic life of one fictional owner (Jordan Okafor, Oakland). It has 425 docs across mail, iMessage, Apple Notes, Calendar, Reminders, files in granted folders, Library items (research, transcripts, documents), chats with Psyche and tasks. It includes hard negatives (last year's lease, two dentist visits) and a few Portuguese docs. Everything is invented.
2. Loads `fixtures/questions.json`: 150 questions. Each has a `class`, an `intent` (`find`, `answer` or `list`), its `gold` source ids, a short `answer` and `answerKeywords`.
   - The classes are exact, paraphrase, temporal, person, list, multihop, crosslingual and filter.
   - The eval clock is Tue 2026-10-20 10:00 PT.
3. Builds an in-memory `SqliteSearchIndex` and runs every question through `index.search` (no collapsing, top 20).

It runs each question three ways (`--mode`):

| Mode | What reaches `index.search` |
| --- | --- |
| `raw` | The question as typed. Bare words are ANDed today, so this is what the Search screen does with English. |
| `keywords` | Stop words dropped, the rest ORed. |
| `rules` | `keywords` plus rule-based pre-filters: time phrases become `after:`/`before:`, "from Maya" becomes `from:maya`, and "email" becomes `in:connectors`. If that finds nothing, it falls back to `keywords`. |

It indexes two coverages (`--coverage`):

- `production`: only the sources the Gateway indexes today (chats, tasks, Library).
- `full`: every source, written straight into the index.
- `indexed`: production plus every local source, written by the real source indexers (`SourceIndexer` over a fake Apple connector, a fake Messages helper and a temp folder; `eval/indexed.ts`). Messages are one document per chat and day, so a hit credits every corpus message of that conversation-day.

## Metrics

Relevance is binary: a result counts when it is a gold id.

| Column | Meaning |
| --- | --- |
| `zero` | Share of questions with no results. |
| `R@k` | Recall at k: the share of gold ids in the top k, averaged over questions. |
| `hit@10` | Share of questions with at least one gold id in the top 10, which is what an answer needs when several sources state the fact. |
| `MRR` | Mean reciprocal rank of the first gold id. |
| `nDCG@10` | Normalised discounted cumulative gain at 10. |
| `cite P@3` | Citation precision. Without `--llm`, a mock answerer cites the top 3 hits. With `--llm`, it is the share of the model's cited ids that are gold. |
| `cite ok` | At least one gold id is cited. |
| `answer ok` | Only with `--llm`: the answer contains every `answerKeywords` entry. |

## Options

| Option | Effect |
| --- | --- |
| `--mode raw\|keywords\|rules` | Run one mode. |
| `--coverage production\|full` | Run one coverage. |
| `--classes` | Add tables per question class. |
| `--misses` | List the questions with R@10 < 1, with their query and top hits. |
| `--only q001,q002` | Run only those questions. |
| `--out report.json` | Also write the summaries as JSON. |
| `--llm` | Answer with `claude-haiku-5-5` from the top 8 hits and score its citations. It reads `ANTHROPIC_API_KEY` from the environment or the nearest `.env`, and never prints it. A full run is about 150 short calls per mode and coverage, so pass `--mode` and `--coverage`. |

## Adding to it

- Add docs to `corpus.json`. Ids are `<source>-NNN`.
- Add questions with complete gold sets. For list questions, include every matching doc.
- `test/eval.test.ts` checks that ids are unique and that every gold id exists.
- A PR that changes ranking, parsing or ingest should paste the before and after tables.
