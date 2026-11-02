import { contentWords, type Reranker } from "../src/index.ts";

/**
 * A stand-in for the cloud reranker (`--mode rerank`, no key needed): orders candidates by the
 * share of the question's content words found in their title and snippet (stable on ties). It
 * measures the plumbing and a weak lexical signal, not Haiku; a real run needs a valid key.
 */
export const coverageReranker: Reranker = {
  id: "coverage-mock",
  cloud: false,
  async rerank(query, candidates) {
    const words = contentWords(query);
    const score = (c: { title: string; text: string }) => {
      const hay = `${c.title} ${c.text}`.toLowerCase();
      return words.length === 0 ? 0 : words.filter((w) => hay.includes(w)).length / words.length;
    };
    return candidates
      .map((c, i) => ({ id: c.id, s: score(c), i }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.id);
  },
};
