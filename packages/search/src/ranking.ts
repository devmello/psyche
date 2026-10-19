import type { RichHit } from "./types.ts";

/** Reciprocal-rank-fusion constant (Cormack et al.); 60 is the usual choice. */
export const RRF_K = 60;

/**
 * Merges ranked lists whose scores are not comparable (FTS5 BM25 here, the memory index's blended
 * score there) by reciprocal rank fusion. Each list keeps its own order; the returned hits carry
 * the fused score so the flat list stays sorted by `score`.
 */
export function fuse(lists: RichHit[][], k = RRF_K): RichHit[] {
  const fused = new Map<string, { hit: RichHit; score: number }>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const key = `${hit.kind}:${hit.id}`;
      const prev = fused.get(key);
      const add = 1 / (k + rank + 1);
      if (prev === undefined) fused.set(key, { hit, score: add });
      else prev.score += add;
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score || b.hit.createdAt - a.hit.createdAt)
    .map(({ hit, score }) => ({ ...hit, score }));
}

/** The recency multiplier the SQL ranking applies: 1 + weight × 0.5^(age / halfLife). */
export function recencyBoost(ageMs: number, halfLifeMs: number, weight: number): number {
  return 1 + weight * 0.5 ** (Math.max(0, ageMs) / halfLifeMs);
}
