/**
 * Retrieval metrics for the search eval (docs/design/search-roadmap-2026.md §9). Relevance is
 * binary: a result is relevant when its id is in the question's `gold` list.
 */

/** Share of gold ids found in the first `k` results. */
export function recallAt(ranked: readonly string[], gold: readonly string[], k: number): number {
  if (gold.length === 0) return 0;
  const top = new Set(ranked.slice(0, k));
  return gold.filter((g) => top.has(g)).length / gold.length;
}

/** 1 / rank of the first gold id, or 0 when none is in `ranked`. */
export function reciprocalRank(ranked: readonly string[], gold: readonly string[]): number {
  const want = new Set(gold);
  const i = ranked.findIndex((id) => want.has(id));
  return i < 0 ? 0 : 1 / (i + 1);
}

/** Normalised discounted cumulative gain at `k` with binary gains. */
export function ndcgAt(ranked: readonly string[], gold: readonly string[], k: number): number {
  const want = new Set(gold);
  let dcg = 0;
  ranked.slice(0, k).forEach((id, i) => {
    if (want.has(id)) dcg += 1 / Math.log2(i + 2);
  });
  let ideal = 0;
  for (let i = 0; i < Math.min(k, gold.length); i++) ideal += 1 / Math.log2(i + 2);
  return ideal === 0 ? 0 : dcg / ideal;
}

export interface CitationScore {
  /** Cited ids that are gold, over cited ids (0 when nothing is cited). */
  precision: number;
  /** Gold ids that are cited, over gold ids. */
  recall: number;
  /** At least one gold id is cited: the answer can be checked against a right source. */
  supported: boolean;
}

export function citationScore(cited: readonly string[], gold: readonly string[]): CitationScore {
  const want = new Set(gold);
  const hits = [...new Set(cited)].filter((id) => want.has(id)).length;
  return {
    precision: cited.length === 0 ? 0 : hits / new Set(cited).size,
    recall: gold.length === 0 ? 0 : hits / gold.length,
    supported: hits > 0,
  };
}

/** Every keyword occurs in the answer, ignoring case and diacritics. */
export function answerMatches(answer: string, keywords: readonly string[]): boolean {
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const a = fold(answer);
  return keywords.every((k) => a.includes(fold(k)));
}

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}
