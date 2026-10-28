import { describe, expect, it } from "vitest";
import { citationScore, ndcgAt, recallAt, reciprocalRank } from "../eval/metrics.ts";
import { rewrite, temporal } from "../eval/rewrite.ts";
import { EVAL_NOW, EVAL_TZ, loadFixtures } from "../eval/run.ts";

/** The search eval harness (packages/search/eval/README.md): metrics, rewrites and fixtures. */

describe("eval metrics", () => {
  it("scores ranked ids against gold", () => {
    expect(recallAt(["a", "x", "b"], ["a", "b"], 2)).toBe(0.5);
    expect(reciprocalRank(["x", "y", "a"], ["a"])).toBeCloseTo(1 / 3);
    expect(ndcgAt(["a", "b"], ["a", "b"], 10)).toBe(1);
    expect(ndcgAt(["x", "a"], ["a"], 10)).toBeCloseTo(1 / Math.log2(3));
    expect(citationScore(["a", "x"], ["a", "b"])).toEqual({
      precision: 0.5,
      recall: 0.5,
      supported: true,
    });
  });
});

describe("eval rewrites", () => {
  it("drops stop words, ORs the rest and keeps typed filters", () => {
    expect(rewrite("What did Maya say about the Lisbon budget?", "keywords", EVAL_NOW).q).toBe(
      "maya OR lisbon OR budget",
    );
    expect(rewrite("from:maya lisbon", "keywords", EVAL_NOW).q).toBe("from:maya lisbon");
  });

  it("turns time phrases into date filters relative to the eval clock (Tue 2026-10-20)", () => {
    expect(temporal("vet visit last week", EVAL_NOW, EVAL_TZ).filters).toEqual([
      "after:2026-10-12",
      "before:2026-10-19",
    ]);
    expect(temporal("receipts in September", EVAL_NOW, EVAL_TZ).filters).toEqual([
      "after:2026-09-01",
      "before:2026-10-01",
    ]);
    expect(temporal("dinner next Thursday", EVAL_NOW, EVAL_TZ).filters).toEqual([
      "after:2026-10-22",
      "before:2026-10-23",
    ]);
    const r = rewrite("What did Maya text me yesterday?", "rules", EVAL_NOW, EVAL_TZ);
    expect(r.q).toBe("after:2026-10-19 before:2026-10-20 from:maya in:connectors maya");
    expect(r.fallback).toBe("maya OR text OR yesterday");
  });
});

describe("eval fixtures", () => {
  it("have unique ids and every gold id exists", () => {
    const { corpus, questions } = loadFixtures();
    const ids = new Set(corpus.map((d) => d.id));
    expect(ids.size).toBe(corpus.length);
    expect(new Set(questions.map((q) => q.id)).size).toBe(questions.length);
    expect(questions.length).toBeGreaterThanOrEqual(100);
    for (const q of questions) {
      expect(q.gold.length, q.id).toBeGreaterThan(0);
      for (const g of q.gold) expect(ids.has(g), `${q.id} → ${g}`).toBe(true);
    }
  });
});
