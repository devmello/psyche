import type { MemoryHandlers, SqliteMemoryStore } from "@psyche/memory";
import { PsycheError } from "@psyche/protocol";
import { OWNER_ONLY_SOURCES } from "@psyche/search";
import type { Call, HandlerDef } from "../context.ts";
import { viewerOf } from "./everything.ts";
import { mountParamsOnly } from "./handlers.ts";
import { forViewer } from "./life-answer-chat.ts";
import type { AnswerViewer } from "./life-passages.ts";

/**
 * `memory.search` and `memory.explain` return the text of indexed Memory chunks. Memory is an
 * owner-only source (`OWNER_ONLY_SOURCES`): the same rules as `memory.life.answer` and
 * `search.document` apply here, through `forViewer`, so a paired phone or a remote Gateway client
 * never receives chunk text it could not open as a source passage. Every chunk of the Markdown
 * memory is a Memory-source passage, so for such a connection none is read at all.
 */

/**
 * Who asks. The desktop app, and the owner's CLI on the Host's own computer, keep today's
 * behaviour; every other connection is restricted. The CLI is added here only: `viewerOf` (life
 * answers) is unchanged.
 */
export function memoryViewerOf(call: Call): AnswerViewer {
  const v = viewerOf(call);
  const cli = call.identity.role === "client" && call.identity.localHostCli === true;
  return cli ? { ...v, desktop: true } : v;
}

/** True when this viewer may open a Memory-source passage: the one rule, `forViewer`'s. */
export const mayReadMemoryChunks = (viewer: AnswerViewer): boolean =>
  forViewer({ source: "memory" }, viewer) !== undefined;

/**
 * A search response as this connection may see it: for one that may not open Memory, every
 * memory-kind hit (a chunk snippet) and the memory group are dropped. Other kinds are unchanged.
 */
export function scrubMemorySearch<
  T extends {
    hits: { kind?: string; group?: string }[];
    groups?: { group?: string; hits: { kind?: string }[] }[];
  },
>(call: Call, res: T): T {
  if (mayReadMemoryChunks(memoryViewerOf(call))) return res;
  const isMemory = (h: { kind?: string; group?: string }) =>
    h.kind === "memory" || h.group === "memory";
  return {
    ...res,
    hits: res.hits.filter((h) => !isMemory(h)),
    ...(res.groups === undefined
      ? {}
      : {
          groups: res.groups
            .filter((g) => g.group !== "memory")
            .map((g) => ({ ...g, hits: g.hits.filter((h) => !isMemory(h)) })),
        }),
  };
}

/**
 * Source ids a connection may not be shown in search results at all (title, snippet or count):
 * the same rule as `search.document`'s `needDocument`, via `forViewer` and plain `viewerOf`.
 */
export const hiddenSearchPrefixes = (call: Call): readonly string[] =>
  OWNER_ONLY_SOURCES.filter((s) => forViewer({ docId: `${s}:x` }, viewerOf(call)) === undefined);

/**
 * `search.query` as this connection may see it. The index already leaves the owner-only sources
 * out (`excludeIdPrefixes`, so `total` and group counts never count them); this is the second
 * pass over what came back: any hit `forViewer` refuses is dropped and subtracted from the
 * counts, then the Memory-chunk scrub runs.
 */
export function scrubSearchForViewer<
  T extends {
    hits: { id: string; kind?: string; group?: string }[];
    groups?: { group?: string; count: number; hits: { id: string; kind?: string }[] }[];
    total: number;
  },
>(call: Call, res: T): T {
  const viewer = viewerOf(call);
  const shown = (h: { id: string }) => forViewer({ docId: h.id }, viewer) !== undefined;
  const refused = new Set<string>();
  for (const h of [...res.hits, ...(res.groups ?? []).flatMap((g) => g.hits)])
    if (!shown(h)) refused.add(h.id);
  if (refused.size === 0) return scrubMemorySearch(call, res);
  return scrubMemorySearch(call, {
    ...res,
    hits: res.hits.filter(shown),
    total: Math.max(0, res.total - refused.size),
    ...(res.groups === undefined
      ? {}
      : {
          groups: res.groups
            .map((g) => {
              const kept = g.hits.filter(shown);
              return {
                ...g,
                count: Math.max(0, g.count - (g.hits.length - kept.length)),
                hits: kept,
              };
            })
            .filter((g) => g.count > 0),
        }),
  });
}

/** The memory handlers, with the chunk-returning methods held to the connection's viewer. */
export function mountMemoryHandlers(
  handlers: MemoryHandlers,
  store: Pick<SqliteMemoryStore, "getClaim">,
): Record<string, HandlerDef> {
  const out = mountParamsOnly(handlers as never);
  out["memory.search"] = {
    run: async (call: Call, params: never) => {
      if (!mayReadMemoryChunks(memoryViewerOf(call))) return { hits: [] };
      return handlers["memory.search"](params);
    },
  };
  out["memory.explain"] = {
    run: async (call: Call, params: never) => {
      if (mayReadMemoryChunks(memoryViewerOf(call))) return handlers["memory.explain"](params);
      // The claim only (as `memory.claims.list` shows it), never the chunks it rests on.
      const claim = store.getClaim((params as { claimId: string }).claimId);
      if (claim === undefined) throw new PsycheError("not_found", "no such claim");
      return { claim, chunks: [] };
    },
  };
  out["memory.export"] = {
    run: async (call: Call, params: never) => {
      // The whole workspace plus claims, lessons and feedback: the desktop app and Host CLI only.
      if (!mayReadMemoryChunks(memoryViewerOf(call)))
        throw new PsycheError("forbidden", "Memory exports from the Psyche app on the Host only", {
          details: { reason: "not_desktop" },
        });
      return handlers["memory.export"](params);
    },
  };
  return out;
}
