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

export const SearchMethods = {
  "search.query": defineMethod({
    params: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 2000 }),
      scopes: Type.Optional(Type.Array(SearchScope)),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    result: Type.Object({
      hits: Type.Array(SearchHit),
      groups: Type.Optional(Type.Array(SearchHitGroup)),
      total: Type.Optional(Type.Integer({ minimum: 0 })),
      warnings: Type.Optional(
        Type.Array(Type.String(), { description: "Filter tokens that were not understood" }),
      ),
    }),
    scope: "operator.read",
    description: "Unified search across the given scopes (default all).",
  }),
} as const;
