import type { MethodParams, MethodResult, SearchHit, SearchScope } from "@psyche/protocol";
import type { SqliteSearchIndex } from "./sqlite-index.ts";
import { OWNER, type RichHit, type SearchGroup, type SearchViewer } from "./types.ts";

/** Wire scopes (`search.query` params) → result groups. */
const GROUPS_OF_SCOPE: Record<SearchScope, SearchGroup> = {
  threads: "threads",
  messages: "threads",
  tasks: "tasks",
  memory: "memory",
  library: "library",
  feed: "feed",
};

/**
 * Wire scope of a hit. Ideas, goals and connector caches have no wire scope until the
 * `protocol:` PR adds them, so the handler leaves them out of `search.query` results.
 */
function scopeOf(hit: RichHit): SearchScope | undefined {
  switch (hit.kind) {
    case "thread":
      return "threads";
    case "message":
      return "messages";
    case "task":
      return "tasks";
    case "memory":
      return "memory";
    case "library":
      return "library";
    case "feed":
      return "feed";
    default:
      return undefined;
  }
}

/** In-app deep link (UI §2.7) for a hit; opening a result lands in its pane. */
export function routeOf(hit: RichHit): string | null {
  const enc = encodeURIComponent;
  switch (hit.kind) {
    case "thread":
      return `/chat/${enc(hit.id)}`;
    case "message":
      return hit.threadId === undefined
        ? null
        : `/chat/${enc(hit.threadId)}?message=${enc(hit.id)}`;
    case "task":
      return `/agent/activity/${enc(hit.parentId ?? hit.id)}`;
    case "memory":
      return `/agent/soul?file=${enc(hit.sourcePath ?? "")}`;
    case "library":
      return `/library/all?item=${enc(hit.id)}`;
    case "feed":
      return `/feed?post=${enc(hit.id)}`;
    case "idea":
      return `/ideas?idea=${enc(hit.id)}`;
    case "goal":
      return `/goals/${enc(hit.id)}`;
    default:
      return null;
  }
}

export interface SearchHandlerContext {
  /** Who is asking. Paired operator devices are the owner; delegated sessions pass their scope. */
  viewer?: SearchViewer;
}

export type SearchHandlers = {
  "search.query": (
    params: MethodParams<"search.query">,
    ctx?: SearchHandlerContext,
  ) => Promise<MethodResult<"search.query">>;
};

/** `search.*` method handlers for the Gateway's dispatcher (params are already validated). */
export function createSearchHandlers(index: SqliteSearchIndex): SearchHandlers {
  return {
    async "search.query"(params, ctx = {}) {
      const groups =
        params.scopes === undefined
          ? undefined
          : [...new Set(params.scopes.map((s) => GROUPS_OF_SCOPE[s]))];
      const res = await index.search({
        q: params.query,
        viewer: ctx.viewer ?? OWNER,
        limit: params.limit ?? 20,
        ...(groups === undefined ? {} : { groups }),
      });
      const onlyMessages =
        params.scopes?.includes("messages") === true && !params.scopes.includes("threads");
      const hits: SearchHit[] = [];
      for (const h of res.hits) {
        const scope = scopeOf(h);
        if (scope === undefined) continue;
        if (params.scopes !== undefined && !params.scopes.includes(scope)) {
          // `threads` covers messages (results collapse onto their thread).
          if (!(scope === "messages" && params.scopes.includes("threads"))) continue;
        }
        if (onlyMessages && scope !== "messages") continue;
        hits.push({
          scope,
          id: h.id,
          title: h.title,
          snippet: h.snippet,
          score: h.score,
          threadId: h.threadId ?? null,
          route: routeOf(h),
        });
      }
      return { hits };
    },
  };
}
