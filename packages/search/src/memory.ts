import type { MemoryStore } from "@psyche/protocol";
import { snippetFor } from "./highlight.ts";
import { highlightTokens, type ParsedQuery } from "./query-parser.ts";
import type { RichHit } from "./types.ts";

/** `memory/2026-10-16.md` → `2026-10-16`; other workspace files keep their path. */
export function memoryTitle(source: string): string {
  const daily = /^memory\/(\d{4}-\d{2}-\d{2})\.md$/.exec(source);
  return daily?.[1] ?? source;
}

/**
 * Memory hits come from `MemoryStore.search` (its own BM25 + vector + recency ranking, data model
 * §7) instead of a copy in this index, so `forget` and dreaming are reflected immediately.
 * Date, provenance and exclusion filters are applied here; the caller has already dropped memory
 * for filters chunks cannot satisfy (`from:`, `has:`, `type:`, `thread:`).
 */
export async function searchMemory(
  store: MemoryStore,
  parsed: ParsedQuery,
  opts: { limit: number; now: number },
): Promise<RichHit[]> {
  if (parsed.text.trim().length === 0) return [];
  const f = parsed.filters;
  const chunks = await store.search(parsed.text, {
    limit: opts.limit,
    ...(f.provenance === undefined ? {} : { provenance: f.provenance }),
  });
  const excluded = parsed.excluded.map((t) => t.text.toLowerCase());
  const tokens = highlightTokens(parsed);
  const hits: RichHit[] = [];
  for (const { chunk, score } of chunks) {
    const created = Date.parse(chunk.createdAt);
    if (f.before !== undefined && !(created < f.before)) continue;
    if (f.after !== undefined && !(created >= f.after)) continue;
    if (f.provenance !== undefined && !f.provenance.includes(chunk.provenance)) continue;
    const lower = chunk.text.toLowerCase();
    if (excluded.some((x) => x.length > 0 && lower.includes(x))) continue;
    const snip = snippetFor(chunk.text, tokens);
    hits.push({
      id: chunk.id,
      kind: "memory",
      group: "memory",
      title: memoryTitle(chunk.source),
      score,
      snippet: snip.text,
      provenance: chunk.provenance,
      createdAt: created,
      snippetHighlights: snip.ranges,
      titleHighlights: [],
      sourcePath: chunk.source,
    });
  }
  return hits;
}
