import { type Static, Type } from "@sinclair/typebox";
import { Id, Nullable, Provenance, StringEnum } from "../common.ts";
import { defineMethod } from "./define.ts";

/**
 * `search.*` (architecture §4.12: unified search over threads, tasks, memory, library, feed,
 * ideas, goals and opted-in connector caches; owner S16, `packages/search`).
 */

export const SearchScope = StringEnum(
  [
    "threads",
    "messages",
    "tasks",
    "memory",
    "library",
    "feed",
    "ideas",
    "goals",
    "connectors",
    "people",
    "projects",
  ],
  {
    $id: "SearchScope",
  },
);
export type SearchScope = Static<typeof SearchScope>;

/** JSON form of the `SearchIndexDocKind` contract type (`contracts/SearchIndex.ts`). */
export const SearchIndexDocKindSchema = StringEnum(
  [
    "thread",
    "message",
    "task",
    "memory",
    "library",
    "feed",
    "idea",
    "goal",
    "connector",
    "person",
    "project",
  ],
  { $id: "SearchIndexDocKind" },
);

/** The pane a result opens in; the Search screen groups by it (UI §3.13). */
export const SearchGroup = StringEnum(
  [
    "threads",
    "tasks",
    "memory",
    "library",
    "feed",
    "ideas",
    "goals",
    "connectors",
    "people",
    "projects",
  ],
  { $id: "SearchGroup" },
);
export type SearchGroup = Static<typeof SearchGroup>;

/** `[start, end)` offsets of matched text inside a hit's `snippet` or `title`. */
export const HighlightRange = Type.Tuple(
  [Type.Integer({ minimum: 0 }), Type.Integer({ minimum: 0 })],
  { $id: "HighlightRange" },
);
export type HighlightRange = Static<typeof HighlightRange>;

/** Which retriever found a hit (docs/design/search-2026.md §5.8); absent when search was lexical only. */
export const SearchMatch = StringEnum(["lexical", "semantic", "both"], { $id: "SearchMatch" });
export type SearchMatch = Static<typeof SearchMatch>;

/**
 * The context card of a result (docs/design/grounded-ingest-2026.md): a summary of the item,
 * the span of its text the summary cites, and questions it answers. Present only for items that
 * have a card; for untrusted items it is data, never an instruction.
 */
export const SearchHitCard = Type.Object(
  {
    summary: Type.String(),
    span: Type.String({ description: "Source text the summary cites" }),
    questions: Type.Array(Type.String()),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { $id: "SearchHitCard" },
);
export type SearchHitCard = Static<typeof SearchHitCard>;

/** One unified-search result; `route` is the in-app deep link. */
export const SearchHit = Type.Object(
  {
    scope: SearchScope,
    id: Id,
    title: Type.String(),
    snippet: Type.String(),
    score: Type.Number(),
    threadId: Nullable(Id),
    route: Nullable(Type.String()),
    kind: Type.Optional(SearchIndexDocKindSchema),
    group: Type.Optional(SearchGroup),
    provenance: Type.Optional(Provenance),
    createdAt: Type.Optional(Type.Integer({ minimum: 0, description: "Epoch ms" })),
    snippetHighlights: Type.Optional(Type.Array(HighlightRange)),
    titleHighlights: Type.Optional(Type.Array(HighlightRange)),
    match: Type.Optional(SearchMatch),
    card: Type.Optional(SearchHitCard),
  },
  { $id: "SearchHit" },
);
export type SearchHit = Static<typeof SearchHit>;

/** One Search-screen section: the best hits of a group and how many distinct results it has. */
export const SearchHitGroup = Type.Object(
  {
    group: SearchGroup,
    count: Type.Integer({
      minimum: 0,
      description: "Distinct results in the group (after collapsing messages onto threads)",
    }),
    hits: Type.Array(SearchHit),
  },
  { $id: "SearchHitGroup" },
);
export type SearchHitGroup = Static<typeof SearchHitGroup>;

/** What kind of filter an understood phrase became (Search screen chips). */
export const SearchChipKind = StringEnum(["time", "person", "source", "type"], {
  $id: "SearchChipKind",
});
export type SearchChipKind = Static<typeof SearchChipKind>;

/** What the asker wants: look something up, get an answer, or list matches. */
export const SearchQueryIntent = StringEnum(["find", "answer", "list"], {
  $id: "SearchQueryIntent",
});
export type SearchQueryIntent = Static<typeof SearchQueryIntent>;

/** How far a query had to be loosened to find anything. */
export const SearchRelaxed = StringEnum(["none", "filters", "or"], { $id: "SearchRelaxed" });
export type SearchRelaxed = Static<typeof SearchRelaxed>;

/** A filter found in plain words ("last week", "from Alex"), shown as a removable chip. */
export const SearchQueryChip = Type.Object(
  {
    id: Type.String({ description: "Pass it in `dropChips` to turn the chip off" }),
    kind: SearchChipKind,
    label: Type.String({
      description:
        "time: the phrase as typed; person: the name; source: mail, imessage, notes, calendar, reminders or files; type: pdf, image, sheet or slides",
    }),
    token: Type.String({ description: "The query-language filter the chip stands for" }),
  },
  { $id: "SearchQueryChip" },
);
export type SearchQueryChip = Static<typeof SearchQueryChip>;

/** How the query was read: its intent, the chips applied and whether it had to be relaxed. */
export const SearchUnderstood = Type.Object(
  {
    natural: Type.Boolean({ description: "Read as a question rather than run as typed" }),
    intent: SearchQueryIntent,
    chips: Type.Array(SearchQueryChip),
    relaxed: SearchRelaxed,
    query: Type.String({ description: "The query that produced the results" }),
  },
  { $id: "SearchUnderstood" },
);
export type SearchUnderstood = Static<typeof SearchUnderstood>;

/** Progress of the index backfill (docs/design/search-2026.md §5.1). */
export const SearchBackfillStatus = Type.Object(
  {
    state: StringEnum(["idle", "running", "done", "error"], { $id: "SearchBackfillState" }),
    done: Type.Integer({ minimum: 0, description: "Documents indexed by this run so far" }),
    source: Type.Optional(
      Type.String({ description: "Store being indexed: threads, messages, tasks, library, …" }),
    ),
    error: Type.Optional(Type.String()),
    startedAt: Type.Optional(Type.Integer({ minimum: 0, description: "Epoch ms" })),
    finishedAt: Type.Optional(Type.Integer({ minimum: 0, description: "Epoch ms" })),
  },
  { $id: "SearchBackfillStatus" },
);
export type SearchBackfillStatus = Static<typeof SearchBackfillStatus>;

/** On-device semantic search (Settings → Model & providers → Search). */
export const SearchSemanticStatus = Type.Object(
  {
    enabled: Type.Boolean(),
    engine: StringEnum(["builtin", "router"], { $id: "SearchSemanticEngine" }),
    state: StringEnum(["off", "downloading", "loading", "indexing", "ready", "error", "blocked"], {
      $id: "SearchSemanticState",
    }),
    model: Type.Optional(
      Type.String({ description: "Vector space in use, e.g. builtin/multilingual-e5-small" }),
    ),
    dims: Type.Optional(Type.Integer({ minimum: 1 })),
    vectors: Type.Optional(Type.Integer({ minimum: 0, description: "Chunk vectors stored" })),
    done: Type.Optional(
      Type.Integer({ minimum: 0, description: "Documents embedded in this pass" }),
    ),
    total: Type.Optional(
      Type.Integer({ minimum: 0, description: "Documents pending when it started" }),
    ),
    receivedBytes: Type.Optional(Type.Integer({ minimum: 0, description: "Model download" })),
    totalBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    cloud: Type.Optional(
      Type.Boolean({
        description: "Text is sent to a cloud embedding service (search.semantic.allowCloud)",
      }),
    ),
    blocked: Type.Optional(
      StringEnum(["no_embedding_model", "cloud_not_allowed"], { $id: "SearchSemanticBlock" }),
    ),
    error: Type.Optional(Type.String()),
  },
  { $id: "SearchSemanticStatus" },
);
export type SearchSemanticStatus = Static<typeof SearchSemanticStatus>;

/** What `search.status` returns and `search.status.updated` carries. */
export const SearchIndexStatus = Type.Object(
  {
    docs: Type.Integer({ minimum: 0, description: "Documents in the index" }),
    backfill: SearchBackfillStatus,
    semantic: Type.Optional(SearchSemanticStatus),
  },
  { $id: "SearchIndexStatus" },
);
export type SearchIndexStatus = Static<typeof SearchIndexStatus>;

export const SearchMethods = {
  "search.query": defineMethod({
    params: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 2000 }),
      scopes: Type.Optional(Type.Array(SearchScope)),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      dropChips: Type.Optional(
        Type.Array(Type.String({ maxLength: 200 }), {
          maxItems: 16,
          description: "Ids of understood chips the user removed",
        }),
      ),
    }),
    result: Type.Object({
      hits: Type.Array(SearchHit),
      understood: Type.Optional(SearchUnderstood),
      groups: Type.Optional(Type.Array(SearchHitGroup)),
      total: Type.Optional(Type.Integer({ minimum: 0 })),
      warnings: Type.Optional(
        Type.Array(Type.String(), { description: "Filter tokens that were not understood" }),
      ),
    }),
    scope: "operator.read",
    description: "Unified search across the given scopes (default all).",
  }),
  "search.status": defineMethod({
    params: Type.Object({}),
    result: SearchIndexStatus,
    scope: "operator.read",
    description: "Index size and backfill progress (Search screen, Settings → Search).",
  }),
  "search.reindex": defineMethod({
    params: Type.Object({}),
    result: Type.Object({
      started: Type.Boolean({ description: "False when a run was already in flight" }),
    }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Rebuilds the search index from the stores in the background; documents that no longer exist are dropped. Progress arrives as search.status.updated. Side-effecting.",
  }),
} as const;
