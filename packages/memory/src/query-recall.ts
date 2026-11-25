import { stripComments } from "./chunker.ts";
import { keywords, parseMemoryBullets, similarity } from "./dreaming.ts";
import type { SqliteMemoryStore } from "./store.ts";

/**
 * Default (Markdown mode) recall for one turn: the agent's notes (`memory/agent/`) and the
 * bullets of MEMORY.md that match the owner's question, found with the BM25 index (words only,
 * no embedder, no network). MEMORY.md is never injected whole, so its bullets reach the prompt
 * only when the question asks for them.
 *
 * Trust: only `owner` and `agent` chunks, and a note file holding any untrusted content is left
 * out whole (the same filter as `recentAgentNotes`). Lines already in USER.md are skipped (that
 * block is injected anyway). When no candidate shares enough words with the question, nothing is
 * returned. Each recalled chunk is counted with `recordRecall`, as `memory_search` does, so
 * dreaming can promote the notes that keep being useful.
 */

const NOTES_PREFIX = "memory/agent/";
const MEMORY_FILE = "MEMORY.md";
const USER_FILE = "USER.md";
/** A USER.md line this similar to a candidate counts as the same fact. */
const DUPLICATE = 0.6;

export interface QueryRecallOptions {
  /** Lines at most (default 5). */
  limit?: number;
  /** Characters across the lines (default 1,100). */
  maxChars?: number;
}

/** Light stemmer so "tomatoes" and "tomato" agree, as the porter index does. */
function stem(w: string): string {
  return w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w;
}

function stems(text: string): Set<string> {
  return new Set([...keywords(text)].map(stem));
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = text.slice(0, Math.max(0, max));
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

const oneLine = (s: string) => stripComments(s).replace(/\s+/g, " ").trim();

interface Candidate {
  path: string;
  text: string;
  chunkId: string;
  matched: number;
  rank: number;
}

export async function queryRecall(
  store: SqliteMemoryStore,
  query: string,
  options: QueryRecallOptions = {},
): Promise<string[]> {
  if (query.trim().length < 3) return [];
  const q = stems(query);
  if (q.size === 0) return [];
  const need = q.size <= 3 ? 1 : 2;
  const hits = await store.search(query, {
    limit: 40,
    provenance: ["owner", "agent"],
    sources: [NOTES_PREFIX, MEMORY_FILE],
  });

  const userLines = ((await store.readFile(USER_FILE))?.content ?? "")
    .split("\n")
    .map(oneLine)
    .filter((l) => l.length > 0);
  const inUser = (text: string): boolean => {
    const t = text.toLowerCase();
    return userLines.some((l) => l.toLowerCase().includes(t) || similarity(l, text) >= DUPLICATE);
  };
  const score = (text: string): number => {
    let n = 0;
    for (const w of stems(text)) if (q.has(w)) n++;
    return n;
  };

  const found: Candidate[] = [];
  const trusted = new Map<string, boolean>();
  hits.forEach((h, rank) => {
    const { source, id } = h.chunk;
    if (source === MEMORY_FILE) {
      for (const b of parseMemoryBullets(h.chunk.text)) {
        const matched = score(b.text);
        if (matched >= need) {
          found.push({ path: source, text: oneLine(b.text), chunkId: id, matched, rank });
        }
      }
      return;
    }
    if (!source.startsWith(NOTES_PREFIX) || !source.endsWith(".md")) return;
    let ok = trusted.get(source);
    if (ok === undefined) {
      const prov = store.contentProvenance(source);
      ok = prov === "agent" || prov === "owner";
      trusted.set(source, ok);
    }
    if (!ok) return;
    const text = oneLine(h.chunk.text);
    const matched = score(text);
    if (text !== "" && matched >= need) {
      found.push({ path: source, text, chunkId: id, matched, rank });
    }
  });
  found.sort((a, b) => b.matched - a.matched || a.rank - b.rank);

  let room = options.maxChars ?? 1_100;
  const limit = options.limit ?? 5;
  const out: string[] = [];
  const chosen: string[] = [];
  const recalled = new Set<string>();
  for (const c of found) {
    if (out.length >= limit || room <= 0) break;
    if (inUser(c.text) || chosen.some((t) => similarity(t, c.text) >= 0.8)) continue;
    // The joined section stays within maxChars: count the prefix and the newline between lines.
    const prefix = `- [${c.path}] `;
    const space = room - (out.length > 0 ? 1 : 0) - prefix.length;
    if (space <= 0) continue;
    const line = `${prefix}${clip(c.text, Math.min(400, space))}`;
    room -= line.length + (out.length > 0 ? 1 : 0);
    out.push(line);
    chosen.push(c.text);
    recalled.add(c.chunkId);
  }
  // A paused memory writes nothing, recall counts included.
  if (recalled.size > 0 && !store.paused) store.recordRecall([...recalled], query);
  return out;
}
