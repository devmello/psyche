import { type Static, Type } from "@sinclair/typebox";
import { Id, Nullable, StringEnum } from "../common.ts";
import { defineMethod } from "./define.ts";

/** `search.*` (architecture §4: unified search over threads, tasks, memory, library, feed). */

export const SearchScope = StringEnum(
  ["threads", "messages", "tasks", "memory", "library", "feed"],
  {
    $id: "SearchScope",
  },
);
export type SearchScope = Static<typeof SearchScope>;

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
  },
  { $id: "SearchHit" },
);
export type SearchHit = Static<typeof SearchHit>;

export const SearchMethods = {
  "search.query": defineMethod({
    params: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 2000 }),
      scopes: Type.Optional(Type.Array(SearchScope)),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    result: Type.Object({ hits: Type.Array(SearchHit) }),
    scope: "operator.read",
    description: "Unified search across the given scopes (default all).",
  }),
} as const;
