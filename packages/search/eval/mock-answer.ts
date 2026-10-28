import { validateAnswer } from "../src/agent/search-everything.ts";
import type { CorpusDoc } from "./run.ts";

/**
 * Mock answer mode for `--mock-answers` (no network, no key): an extractive "model" stands in for
 * the synthesis call. It picks, from each of the top hits, the sentence that shares the most words
 * with the question, and cites that hit. The sentences then go through the same validation as the
 * real tool (`validateAnswer`): cited ids must be in the hit set and the cited text must support
 * the sentence. So the metrics measure retrieval + the citation guard, not a language model.
 */

const WORD = /[\p{L}\p{N}]+/gu;
const words = (s: string) =>
  new Set((s.toLowerCase().match(WORD) ?? []).filter((w) => w.length > 2));

export function mockAnswer(
  question: string,
  sources: readonly CorpusDoc[],
): { answer: string; citations: string[]; dropped: number } {
  const q = words(question);
  const sentences = sources.flatMap((d) =>
    d.text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 8)
      .map((t) => ({
        id: d.id,
        text: t,
        score: [...words(t)].filter((w) => q.has(w)).length,
      })),
  );
  const best = sentences
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  const texts = Object.fromEntries(sources.map((d) => [d.id, `${d.title}\n${d.text}`]));
  const { sentences: kept, dropped } = validateAnswer(
    { sentences: best.map((s) => ({ text: s.text, cites: [s.id] })) },
    texts,
  );
  return {
    answer: kept.map((s) => s.text).join(" "),
    citations: [...new Set(kept.flatMap((s) => s.cites))],
    dropped,
  };
}
