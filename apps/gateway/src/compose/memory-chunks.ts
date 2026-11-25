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

/**
 * Workspace files a connection that may not open Memory can still read: exactly the persona file,
 * whose content `memory.persona.get` returns to it already. An allowlist of one exact name, folded
 * the way APFS folds (case and Unicode); any other spelling or path is refused, never resolved.
 */
const PERSONA_FILE = "IDENTITY.md";

/**
 * ASCII case-insensitive only: no Unicode folding, so `ıdentıty.md`, `ＩＤＥＮＴＩＴＹ.md` and
 * `IDENTITY.ｍｄ` are different files and are refused. A path that passes is read as the literal
 * {@link PERSONA_FILE}, never as the spelling the caller sent.
 */
export const isRemoteReadablePath = (path: string): boolean =>
  /^[iI][dD][eE][nN][tT][iI][tT][yY]\.[mM][dD]$/.test(path);

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
    total?: number;
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
    ...(res.total === undefined ? {} : { total: Math.max(0, res.total - refused.size) }),
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
  // Workspace files (USER.md, MEMORY.md, people/*, memory/*) are Memory passages too: search hides
  // them from a connection that may not open Memory, so reading or listing them does the same.
  // The one thing it still gets is the persona file, which `memory.persona.get` already returns.
  out["memory.read"] = {
    run: async (call: Call, params: never) => {
      if (!mayReadMemoryChunks(memoryViewerOf(call))) {
        const path = (params as { path?: unknown }).path;
        if (typeof path !== "string" || !isRemoteReadablePath(path))
          throw new PsycheError(
            "forbidden",
            "Memory files open in the Psyche app on the Host only",
            {
              details: { reason: "not_desktop" },
            },
          );
      }
      // A connection that may not open Memory reads the persona file by its one literal name.
      if (!mayReadMemoryChunks(memoryViewerOf(call)))
        return handlers["memory.read"]({ ...(params as object), path: PERSONA_FILE } as never);
      return handlers["memory.read"](params);
    },
  };
  // `memory.forget` reports which files, chunks and claims match a word (`dryRun`) or deletes the
  // lines: a word-level oracle over files this connection cannot read. Same refusal as `memory.export`.
  out["memory.forget"] = {
    run: async (call: Call, params: never) => {
      if (!mayReadMemoryChunks(memoryViewerOf(call)))
        throw new PsycheError("forbidden", "Memory forgets from the Psyche app on the Host only", {
          details: { reason: "not_desktop" },
        });
      return handlers["memory.forget"](params);
    },
  };
  out["memory.files.list"] = {
    run: async (call: Call, params: never) => {
      const res = await handlers["memory.files.list"](params);
      if (mayReadMemoryChunks(memoryViewerOf(call))) return res;
      // Only the files this connection may read: the names of people and projects are Memory too.
      return { ...res, files: res.files.filter((f) => isRemoteReadablePath(f.path)) };
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

/** What the Gateway knows of a paired device, for {@link gateMemoryEntities}. */
export interface EntityDeviceFacts {
  platform: string;
  family: string | null;
  paired: boolean;
  revoked: boolean;
}

/** App families that may use People data: the iOS app and the desktop app (a remote Mac). */
const ENTITY_FAMILIES: ReadonlySet<string> = new Set(["ios", "desktop"]);

/**
 * Methods that open People and projects data in the owner's Memory beyond the `memory.entities.`
 * prefix: the graph's map and its admin writes, and the anchors. `memory.loops.*` is not here: it
 * has its own scrub.
 */
const GATED_EXTRA = new Set([
  "memory.graph.map",
  "memory.graph.forgetAll",
  "memory.graph.deleteSource",
  "memory.graph.blocklist.list",
  "memory.graph.blocklist.add",
  "memory.graph.blocklist.remove",
]);

/**
 * Methods that return raw rows (evidence quotes, hidden loops, quarantine text): the desktop app
 * and the Host CLI only, never a paired phone.
 */
const DESKTOP_ONLY = new Set(["memory.entities.export"]);

const isGated = (name: string): boolean =>
  name.startsWith("memory.entities.") ||
  name.startsWith("memory.anchors.") ||
  GATED_EXTRA.has(name);

/**
 * People and projects in the owner's Memory (owner decision 2026-11-25: "Yes, phone too").
 * Allowed: the desktop app and the Host CLI, and a paired, not revoked owner device holding a
 * write scope, reached with no browser `Origin` and declaring the `ios` or `desktop` family (the
 * families that can pair with a setup token). A device paired before the family was recorded
 * (null) passes only as a `macos` platform. The method's own scope still applies on top.
 * `memory.entities.export` is the desktop app and Host CLI only. Refused with `forbidden`:
 * `details.reason = "web_shell"` for anything from a browser (an `Origin`, family or platform
 * `web`), else `not_desktop`. A failed lookup refuses. Applied once over the final handler map,
 * so the scrubs inside (`withLoopViewer`, `attachGistSources`) still run for remote devices.
 */
export function gateMemoryEntities(
  handlers: Record<string, HandlerDef>,
  deviceOf: (deviceId: string) => EntityDeviceFacts | undefined,
): void {
  const refuse = (reason: "not_desktop" | "web_shell") =>
    new PsycheError(
      "forbidden",
      reason === "web_shell"
        ? "People and projects open in the Psyche app on your Mac or iPhone"
        : "People and projects open in the Psyche app on the Host or a paired device only",
      { details: { reason } },
    );
  const allowed = (call: Call, name: string): "ok" | "not_desktop" | "web_shell" => {
    if (mayReadMemoryChunks(memoryViewerOf(call))) return "ok";
    if (DESKTOP_ONLY.has(name)) return "not_desktop";
    const peer = call.conn?.peer;
    // The server-recorded Origin: only a browser sends one. No peer record, no entry.
    if (peer === undefined) return "not_desktop";
    if (peer.origin !== null) return "web_shell";
    const id = call.identity;
    if (id.role !== "client" || id.deviceId === undefined) return "not_desktop";
    if (!id.scopes?.includes("operator.write") && !id.scopes?.includes("operator.admin"))
      return "not_desktop";
    let d: EntityDeviceFacts | undefined;
    try {
      d = deviceOf(id.deviceId);
    } catch {
      return "not_desktop";
    }
    if (d === undefined || !d.paired || d.revoked) return "not_desktop";
    if (d.platform === "web" || d.family === "web") return "web_shell";
    if (d.family === null) return d.platform === "macos" ? "ok" : "not_desktop";
    return ENTITY_FAMILIES.has(d.family) ? "ok" : "not_desktop";
  };
  for (const [name, def] of Object.entries(handlers)) {
    if (!isGated(name)) continue;
    handlers[name] = {
      ...def,
      run: async (call: Call, params: never) => {
        const verdict = allowed(call, name);
        if (verdict !== "ok") throw refuse(verdict);
        return (def.run as (c: Call, p: never) => unknown)(call, params);
      },
    } as HandlerDef;
  }
}
