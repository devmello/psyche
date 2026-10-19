import { describe, expect, it } from "vitest";
import type { SearchDoc } from "../src/types.ts";
import { DAY, NOW, setup } from "./helpers.ts";

// Feature S1: "sub-second results on a year of data". The strict 1 s budget applies locally and
// whenever PSYCHE_PERF=1. Shared GitHub runners are 2-3x slower and noisy, so plain CI runs get 3 s;
// the relative check below still catches a lost index there, since it compares two timings taken on
// the same machine.
const STRICT = !process.env.CI || process.env.PSYCHE_PERF === "1";
const BUDGET_MS = STRICT ? 1000 : 3000;
// Each query runs once untimed (cold statement cache, first page-in), then RUNS times; we assert on
// the median so one scheduler hiccup on a shared runner cannot fail the build.
const RUNS = 3;
// A rare term (101 hits) must be at least this many times faster than a common one (~50k hits).
// Locally the ratio is ~100x; if the FTS index stopped being used both would scan the corpus.
const SELECTIVITY_RATIO = 4;

// A year of personal data: 100k documents across every kind, deterministic text.
const WORDS = (
  "dentist lisbon flight hotel invoice receipt school museum permission slip calendar meeting " +
  "project budget report grocery recipe running marathon doctor insurance renewal mortgage " +
  "birthday gift partner vacation passport visa train ticket concert review subscription " +
  "netflix spotify gym yoga plumber electrician garden tomato basil laptop backup photo album"
).split(" ");
const KINDS = [
  "message",
  "message",
  "message",
  "thread",
  "task",
  "library",
  "feed",
  "idea",
  "goal",
  "connector",
] as const;
const SENDERS = [
  "alice@example.com",
  "bob@example.com",
  "carol@example.org",
  "school@district.edu",
];

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

async function medianMs(fn: () => Promise<unknown>): Promise<number> {
  await fn();
  const times: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)] as number;
}

function* corpus(n: number): Generator<SearchDoc> {
  const r = rng(42);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)] as T;
  for (let i = 0; i < n; i += 1) {
    const words = Array.from({ length: 30 + Math.floor(r() * 60) }, () => pick(WORDS));
    if (i % 997 === 0) words.push("zanzibar");
    const kind = pick(KINDS);
    yield {
      id: `doc${i}`,
      kind,
      title: words.slice(0, 4).join(" "),
      text: words.join(" "),
      provenance: kind === "feed" || kind === "connector" ? "untrusted" : "owner",
      ...(kind === "message" ? { threadId: `T${i % 3000}`, from: pick(SENDERS) } : {}),
      ...(kind === "library" ? { mime: i % 2 === 0 ? "application/pdf" : "image/jpeg" } : {}),
      createdAt: NOW - Math.floor(r() * 365 * DAY),
    };
  }
}

describe("performance on a year of data (100k documents)", () => {
  it("answers typical queries in well under a second", { timeout: 180_000 }, async () => {
    const { index } = setup();
    await index.indexMany(corpus(100_000));
    expect(await index.count()).toBe(100_000);
    index.optimize();

    const queries = [
      "dentist", // matches ~half the corpus
      "zanzibar", // rare
      "dentist lisbon flight",
      "flig", // prefix
      "invoice from:alice in:threads after:90d",
      "type:pdf in:library",
      "has:approval",
      '"permission slip" -museum',
    ];
    const searchMs = new Map<string, number>();
    for (const q of queries) {
      const ms = await medianMs(() => index.search({ q }));
      searchMs.set(q, ms);
      if (process.env.PSYCHE_PERF_LOG === "1") console.warn(`search ${q}: ${ms.toFixed(0)} ms`);
      expect(ms, `search ${q} median ${ms.toFixed(0)} ms`).toBeLessThan(BUDGET_MS);
      const qms = await medianMs(() => index.query({ q, limit: 20 }));
      expect(qms, `query ${q} median ${qms.toFixed(0)} ms`).toBeLessThan(BUDGET_MS);
    }

    const common = searchMs.get("dentist") as number;
    const rare = searchMs.get("zanzibar") as number;
    expect(
      rare * SELECTIVITY_RATIO,
      `rare-term search (${rare.toFixed(1)} ms) should be far cheaper than a common one (${common.toFixed(1)} ms)`,
    ).toBeLessThan(common);
    expect((await index.search({ q: "zanzibar" })).total).toBe(101);
  });
});
