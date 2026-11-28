import { stripComments } from "./chunker.ts";
import { dailyNotePath } from "./layout.ts";
import type { SqliteMemoryStore } from "./store.ts";
import { previousDate } from "./support.ts";

/**
 * Persona files the prompt may hold for the owner's private sessions (templates/README.md). The
 * prompt itself is assembled in `@psyche/agent-core`, which owns the budgets and markers.
 */
const PRIVATE_PERSONA_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "AGENTS.md",
  "USER.md",
  "MEMORY.md",
  "BOOTSTRAP.md",
] as const;

/** Cuts at most `max` UTF-16 units without splitting a surrogate pair. */
function cut(text: string, max: number): string {
  let out = text.slice(0, Math.max(0, max));
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

export interface MemoryRecallOptions {
  /** Snippets at most (default 6). */
  limit?: number;
  /** Characters across the snippets (default 1,600). */
  maxChars?: number;
}

/**
 * Recall for one turn (setting `memory.recall.mode: embeddings`): the memory chunks most
 * relevant to `query`, as `- [path] text` lines, for the owner's private sessions. Only `owner`
 * and `agent` chunks (never `untrusted` or `system`), and none of the files the persona block
 * and the daily notes already inject in full, so the section is trusted and adds what the prompt
 * would otherwise miss. Uses whatever the index has: meaning and words with an embedder, words
 * only without one (the plain text fallback).
 */
export async function memoryRecall(
  store: SqliteMemoryStore,
  query: string,
  options: MemoryRecallOptions = {},
): Promise<string[]> {
  if (query.trim().length < 3) return [];
  const limit = options.limit ?? 6;
  let room = options.maxChars ?? 1_600;
  const today = store.now().date;
  const injected = new Set([
    ...PRIVATE_PERSONA_FILES,
    dailyNotePath(today),
    dailyNotePath(previousDate(today)),
  ]);
  const hits = await store.search(query, { limit: limit * 3, provenance: ["owner", "agent"] });
  const out: string[] = [];
  const recalled: string[] = [];
  for (const h of hits) {
    if (out.length >= limit || room <= 0) break;
    if (injected.has(h.chunk.source)) continue;
    const text = stripComments(h.chunk.text).replace(/\s+/g, " ").trim();
    if (text === "") continue;
    const line = `- [${h.chunk.source}] ${cut(text, Math.min(400, room))}`;
    room -= line.length;
    out.push(line);
    recalled.push(h.chunk.id);
  }
  // Counted like a `memory_search` recall, so dreaming can promote what keeps being useful.
  store.recordRecall(recalled, query);
  return out;
}
