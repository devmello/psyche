import { describe, expect, it } from "vitest";
import { normalize, VectorCache } from "../src/semantic.ts";

/** G11: `dropDoc` through a per-document slot index, checked against a plain reference model. */

const DIMS = 4;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function vector(next: () => number): Float32Array {
  return normalize(Array.from({ length: DIMS }, () => next() * 2 - 1));
}

/** Live chunk ids the cache returns for a query that matches everything. */
function liveIds(cache: VectorCache): string[] {
  return cache
    .nearest(normalize([1, 1, 1, 1]), 100_000)
    .map((r) => r.id)
    .sort();
}

describe("VectorCache.dropDoc (G11)", () => {
  it("drops only the named document's chunks and keeps the others", () => {
    const cache = new VectorCache(DIMS);
    const next = rng(7);
    for (const doc of ["a", "b", "c"]) {
      for (let n = 0; n < 3; n++) cache.put(`${doc}#${n}@m`, doc, vector(next));
    }
    cache.dropDoc("b");
    expect(liveIds(cache)).toEqual(["a#0@m", "a#1@m", "a#2@m", "c#0@m", "c#1@m", "c#2@m"]);
    expect(cache.size).toBe(6);
  });

  it("follows a chunk that moves to another document, and a revived chunk", () => {
    const cache = new VectorCache(DIMS);
    const next = rng(9);
    cache.put("x", "a", vector(next));
    cache.put("y", "a", vector(next));
    // The same chunk id is written under another document (a re-embed with a new owner).
    cache.put("x", "b", vector(next));
    cache.dropDoc("a");
    expect(liveIds(cache)).toEqual(["x"]);
    cache.dropDoc("b");
    expect(liveIds(cache)).toEqual([]);
    // Revived under its own document again: it is found, and dropDoc still reaches it.
    cache.put("x", "a", vector(next));
    expect(liveIds(cache)).toEqual(["x"]);
    cache.dropDoc("a");
    expect(liveIds(cache)).toEqual([]);
  });

  it("stays correct against a reference model through random puts and drops", () => {
    const next = rng(42);
    const docs = ["d0", "d1", "d2", "d3", "d4", "d5"];
    const model = new Map<string, { doc: string; v: Float32Array }>();
    const cache = new VectorCache(DIMS, 4); // small capacity, so the arrays grow during the run
    for (let step = 0; step < 1500; step++) {
      const roll = next();
      if (roll < 0.6) {
        const id = `c${Math.floor(next() * 80)}`;
        const doc = docs[Math.floor(next() * docs.length)] as string;
        const v = vector(next);
        model.set(id, { doc, v });
        cache.put(id, doc, v);
      } else if (roll < 0.9) {
        const id = `c${Math.floor(next() * 80)}`;
        model.delete(id);
        cache.drop(id);
      } else {
        const doc = docs[Math.floor(next() * docs.length)] as string;
        for (const [id, row] of [...model]) if (row.doc === doc) model.delete(id);
        cache.dropDoc(doc);
      }
      if (step % 100 === 99) {
        expect(liveIds(cache)).toEqual([...model.keys()].sort());
      }
    }
    expect(liveIds(cache)).toEqual([...model.keys()].sort());
  });

  it("is correct after compaction: a rebuilt cache from the live rows drops by document", () => {
    const next = rng(5);
    const first = new VectorCache(DIMS);
    const live: { id: string; doc: string; v: Float32Array }[] = [];
    for (let i = 0; i < 60; i++) {
      const doc = `d${i % 5}`;
      const v = vector(next);
      first.put(`c${i}`, doc, v);
      if (i % 3 !== 0) first.drop(`c${i}`);
      else live.push({ id: `c${i}`, doc, v });
    }
    // The index compacts by building a fresh cache from the live rows (see SemanticIndex).
    const rebuilt = new VectorCache(DIMS);
    for (const row of live) rebuilt.put(row.id, row.doc, row.v);
    expect(rebuilt.deadRatio).toBe(0);
    rebuilt.dropDoc("d0");
    const expected = live
      .filter((row) => row.doc !== "d0")
      .map((row) => row.id)
      .sort();
    expect(liveIds(rebuilt)).toEqual(expected);
  });
});
