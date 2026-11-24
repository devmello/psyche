import type { MemoryHandlers, SqliteMemoryStore } from "@psyche/memory";
import { PsycheError } from "@psyche/protocol";
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
  return out;
}
