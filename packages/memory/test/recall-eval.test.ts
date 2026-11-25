import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryRecall, recentAgentNotes } from "../src/index.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * Recall-quality eval. A synthetic owner (tests/fixtures/memory-eval) with MEMORY.md, USER.md,
 * agent notes and daily notes, and labelled queries. It runs the real recall code that the
 * Gateway's `memory_recall` provider calls (compose/memory-recall.ts) in its two modes:
 *   - markdown: `recentAgentNotes` (the default; the 5 newest agent notes whatever the query)
 *   - fts: `memoryRecall` without an embedder (BM25 words only)
 * and compares the numbers with `baseline.json`, so later waves cannot regress silently.
 * After an intended change: `PSYCHE_EVAL_WRITE_BASELINE=1 pnpm exec vitest run
 * packages/memory/test/recall-eval.test.ts --maxWorkers=1` rewrites it (review the diff).
 */

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures/memory-eval",
);
/** The provider's own limits (apps/gateway/src/compose/memory-recall.ts). */
const LIMIT = 5;
const MAX_CHARS = 1_100;
/** Allowed slack on rates and relative slack on characters before the test fails. */
const RATE_TOLERANCE = 0.03;
const CHARS_SLACK = 1.15;

interface EvalQuery {
  id: string;
  category: string;
  q: string;
  expect: string[];
  stale?: string[];
}
interface Notes {
  daily: { path: string; text: string }[];
  agent: { path: string; text: string }[];
}
interface Metrics {
  recallAt5: number;
  injectedPrecision: number;
  emptyCorrectness: number;
  staleHitRate: number;
  avgChars: number;
  totalChars: number;
  queries: number;
}
type Mode = "markdown" | "fts";

const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const queries = (JSON.parse(read("queries.json")) as { queries: EvalQuery[] }).queries;
const notes = JSON.parse(read("notes.json")) as Notes;

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv();
  const { store, clock } = env;
  await store.writeFileAsOwner("MEMORY.md", read("workspace/MEMORY.md"));
  await store.writeFileAsOwner("USER.md", read("workspace/USER.md"));
  for (const d of notes.daily) await store.writeFileAsOwner(d.path, d.text);
  // One minute apart, so "newest" is well defined.
  for (const n of notes.agent) {
    clock.advance(60_000);
    await store.writeFile(n.path, n.text, { provenance: "agent" });
  }
  await store.idle();
});
afterAll(async () => {
  await env?.cleanup();
});

async function recall(mode: Mode, q: string): Promise<string[]> {
  return mode === "markdown"
    ? recentAgentNotes(env.store, { limit: LIMIT, maxChars: MAX_CHARS })
    : memoryRecall(env.store, q, { limit: LIMIT, maxChars: MAX_CHARS });
}

const has = (line: string, marker: string) => line.toLowerCase().includes(marker.toLowerCase());

async function measure(mode: Mode): Promise<Metrics> {
  let recallSum = 0;
  let withExpect = 0;
  let lines = 0;
  let relevant = 0;
  let empties = 0;
  let emptiesOk = 0;
  let staleQueries = 0;
  let staleChecked = 0;
  let chars = 0;
  for (const query of queries) {
    const out = (await recall(mode, query.q)).slice(0, LIMIT);
    chars += out.join("\n").length;
    lines += out.length;
    const markers = query.expect.map((m) => m.toLowerCase());
    relevant += out.filter((l) => markers.some((m) => has(l, m))).length;
    if (markers.length === 0) {
      empties++;
      if (out.length === 0) emptiesOk++;
    } else {
      withExpect++;
      recallSum += markers.filter((m) => out.some((l) => has(l, m))).length / markers.length;
    }
    if (query.stale !== undefined) {
      staleChecked++;
      if (out.some((l) => query.stale?.some((m) => has(l, m)))) staleQueries++;
    }
  }
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    recallAt5: round(recallSum / withExpect),
    // No injected line at all is a precision of 1: nothing wrong was injected.
    injectedPrecision: lines === 0 ? 1 : round(relevant / lines),
    emptyCorrectness: round(emptiesOk / empties),
    staleHitRate: round(staleQueries / staleChecked),
    avgChars: Math.round(chars / queries.length),
    totalChars: chars,
    queries: queries.length,
  };
}

describe("recall-quality eval", () => {
  it("has a fixture set that covers every case the eval promises", () => {
    expect(queries.length).toBeGreaterThanOrEqual(40);
    expect(new Set(queries.map((q) => q.id)).size).toBe(queries.length);
    const cats = new Set(queries.map((q) => q.category));
    for (const c of ["direct", "paraphrase", "people", "old_vs_new", "distractor", "none"]) {
      expect(cats.has(c), c).toBe(true);
    }
    expect(queries.filter((q) => q.category === "none").every((q) => q.expect.length === 0)).toBe(
      true,
    );
  });

  it("every expected marker exists in the corpus (the labels are answerable)", async () => {
    const corpus = [
      read("workspace/MEMORY.md"),
      ...notes.daily.map((d) => d.text),
      ...notes.agent.map((n) => n.text),
    ]
      .join("\n")
      .toLowerCase()
      .replace(/\s+/g, " ");
    for (const q of queries) {
      for (const m of [...q.expect, ...(q.stale ?? [])]) {
        expect(corpus.includes(m.toLowerCase()), `${q.id}: ${m}`).toBe(true);
      }
    }
  });

  it("measures both modes and holds the committed baseline", async () => {
    const result: Record<Mode, Metrics> = {
      markdown: await measure("markdown"),
      fts: await measure("fts"),
    };
    // biome-ignore lint/suspicious/noConsole: the eval prints its numbers on purpose
    console.log(`recall eval (${queries.length} queries)\n${JSON.stringify(result, null, 2)}`);

    const baselinePath = join(FIXTURES, "baseline.json");
    if (process.env.PSYCHE_EVAL_WRITE_BASELINE === "1") {
      writeFileSync(baselinePath, `${JSON.stringify(result, null, 2)}\n`);
    }
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<Mode, Metrics>;
    for (const mode of ["markdown", "fts"] as const) {
      const now = result[mode];
      const was = baseline[mode];
      expect(now.queries, mode).toBe(was.queries);
      expect(now.recallAt5, `${mode} recall@5`).toBeGreaterThanOrEqual(
        was.recallAt5 - RATE_TOLERANCE,
      );
      expect(now.injectedPrecision, `${mode} precision`).toBeGreaterThanOrEqual(
        was.injectedPrecision - RATE_TOLERANCE,
      );
      expect(now.emptyCorrectness, `${mode} empty-correctness`).toBeGreaterThanOrEqual(
        was.emptyCorrectness - RATE_TOLERANCE,
      );
      expect(now.staleHitRate, `${mode} stale hits`).toBeLessThanOrEqual(
        was.staleHitRate + RATE_TOLERANCE,
      );
      expect(now.totalChars, `${mode} chars`).toBeLessThanOrEqual(
        Math.ceil(was.totalChars * CHARS_SLACK) + 100,
      );
    }
  });
});
