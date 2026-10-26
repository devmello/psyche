import type {
  MethodParams,
  MethodResult,
  SearchHit,
  SearchIndexDocKind,
  SearchScope,
} from "@psyche/protocol";
import type { SqliteSearchIndex } from "./sqlite-index.ts";
import { OWNER, type RichHit, type SearchViewer } from "./types.ts";

/** Wire scopes (`search.query` params) → document kinds. */
const KINDS_OF_SCOPE: Record<SearchScope, SearchIndexDocKind[]> = {
  threads: ["thread", "message"],
  messages: ["message"],
  tasks: ["task"],
  memory: ["memory"],
  library: ["library"],
  feed: ["feed"],
  ideas: ["idea"],
  goals: ["goal"],
  connectors: ["connector"],
  people: ["person"],
  projects: ["project"],
};
const ALL_SCOPES = Object.keys(KINDS_OF_SCOPE) as SearchScope[];

/** Wire scope of a hit. */
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
    case "idea":
      return "ideas";
    case "goal":
      return "goals";
    case "connector":
      return "connectors";
    case "person":
      return "people";
    case "project":
      return "projects";
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
    case "person":
    case "project":
      // The card in the agent sheet's People & projects section (people-and-projects §6.5).
      return `/agent/soul?entity=${enc(hit.id.replace(/^entity:/, ""))}`;
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
      const scopes = params.scopes ?? ALL_SCOPES;
      // Only kinds of the requested scopes are ranked, so other kinds cannot use up the limit.
      const kinds = [...new Set(scopes.flatMap((s) => KINDS_OF_SCOPE[s]))];
      const res = await index.search({
        q: params.query,
        viewer: ctx.viewer ?? OWNER,
        limit: params.limit ?? 20,
        kinds,
        // `threads` shows one result per conversation; `messages` alone lists every message.
        collapse: scopes.includes("threads") || !scopes.includes("messages"),
      });
      const hits: SearchHit[] = [];
      for (const h of res.hits) {
        const scope = scopeOf(h);
        if (scope === undefined) continue;
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
