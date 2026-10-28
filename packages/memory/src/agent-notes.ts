import {
  AGENT_NOTES_DIR,
  type MethodParams,
  type MethodResult,
  PsycheError,
} from "@psyche/protocol";
import { isProtected } from "./layout.ts";
import type { SqliteMemoryStore } from "./store.ts";

/**
 * `memory.notes.*` handlers: the owner's view of what Psyche noted for itself (`memory/agent/`).
 * The agent writes there with the memory tool like anywhere else (no approval, its own
 * provenance, `untrusted` when the turn was tainted); the owner lists and deletes. Delete is the
 * owner's own write and never leaves the folder, so protected files stay out of reach.
 */

const TEXT_CAP = 600;

export type AgentNoteHandlers = {
  [M in "memory.notes.list" | "memory.notes.delete"]: (
    params: MethodParams<M>,
  ) => Promise<MethodResult<M>>;
};

export function createAgentNoteHandlers(store: SqliteMemoryStore): AgentNoteHandlers {
  /** Canonical path inside the notes folder, or a refusal (case variants resolve first). */
  const noteOf = (path: string): string => {
    const p = store.canonicalPath(path);
    if (!p.startsWith(AGENT_NOTES_DIR) || !p.endsWith(".md") || isProtected(p)) {
      throw new PsycheError("invalid_params", "only notes under memory/agent/ can be removed here");
    }
    return p;
  };
  return {
    async "memory.notes.list"() {
      const notes = [];
      for (const info of await store.listFileInfo(AGENT_NOTES_DIR)) {
        if (!info.path.endsWith(".md")) continue;
        const file = await store.readFile(info.path);
        if (file === undefined) continue;
        notes.push({
          path: info.path,
          updatedAt: info.updatedAt,
          text: file.content.trim().slice(0, TEXT_CAP),
          bytes: info.bytes,
          provenance: store.contentProvenance(info.path),
        });
      }
      notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { notes };
    },
    async "memory.notes.delete"(p) {
      const path = noteOf(p.path);
      if ((await store.readFile(path)) === undefined) return { removed: false };
      await store.delete(path, { provenance: "owner", actor: "owner", source: "api" });
      return { removed: true };
    },
  };
}

/**
 * The agent's most recent notes as prompt lines (`- [path] text`), newest first, within
 * `maxChars`. Markdown recall mode has no search to surface them, so they ride along instead.
 * Files holding any `untrusted` content are left out: only owner and agent text is trusted.
 */
export async function recentAgentNotes(
  store: SqliteMemoryStore,
  options: { limit?: number; maxChars?: number } = {},
): Promise<string[]> {
  let room = options.maxChars ?? 1_100;
  const out: string[] = [];
  const infos = (await store.listFileInfo(AGENT_NOTES_DIR))
    .filter((i) => i.path.endsWith(".md"))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const info of infos) {
    if (out.length >= (options.limit ?? 5) || room <= 0) break;
    const prov = store.contentProvenance(info.path);
    if (prov !== "agent" && prov !== "owner") continue;
    const file = await store.readFile(info.path);
    const text = file?.content
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text === undefined || text === "") continue;
    const line = `- [${info.path}] ${text.slice(0, Math.min(400, room))}`;
    room -= line.length;
    out.push(line);
  }
  return out;
}
