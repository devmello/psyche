import { describe, expect, it } from "vitest";
import type { SearchDoc } from "../src/types.ts";
import { DAY, NOW, setup } from "./helpers.ts";

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
    for (const q of queries) {
      const t0 = performance.now();
      const res = await index.search({ q });
      const ms = performance.now() - t0;
      if (process.env.PSYCHE_PERF_LOG === "1") console.warn(`search ${q}: ${ms.toFixed(0)} ms`);
      expect(ms, `search ${q} took ${ms.toFixed(0)} ms`).toBeLessThan(1000);
      expect(res.tookMs).toBeLessThan(1000);
      const t1 = performance.now();
      await index.query({ q, limit: 20 });
      expect(performance.now() - t1, `query ${q}`).toBeLessThan(1000);
    }
    expect((await index.search({ q: "zanzibar" })).total).toBe(101);
  });
});
