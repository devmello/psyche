import { describe, expect, it } from "vitest";
import { fakeEmbedder } from "../src/fake-embedder.ts";
import { chunksOf, SemanticIndex } from "../src/semantic.ts";
import { doc, setup } from "./helpers.ts";

/** S3 (docs/design/search-2026.md §5): hybrid search with a fake embedder; no real model runs. */

const GROUPS = [
  ["budget", "spend", "cost", "money"],
  ["trip", "lisbon", "travel", "holiday"],
];
const noSleep = async () => undefined;

function semanticSetup(embedder = fakeEmbedder(GROUPS)) {
  const { index, clock } = setup();
  const semantic = new SemanticIndex(index.db, { floor: 0.5, sleep: noSleep });
  index.setSemantic(semantic);
  semantic.setEmbedder(embedder);
  return { index, semantic, embedder, clock };
}

const vectorCount = (db: ReturnType<typeof setup>["index"]["db"]) =>
  (db.prepare("SELECT count(*) AS n FROM search_vectors").get() as { n: number }).n;

describe("chunksOf", () => {
  it("skips short texts, keeps one chunk for normal ones and splits long ones with overlap", () => {
    expect(chunksOf("message", "Chat", "ok thanks")).toEqual([]);
    expect(chunksOf("task", "Book", "the dentist for Thursday afternoon")).toEqual([
      "Book the dentist for Thursday afternoon",
    ]);
    const long = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunksOf("library", "Notes", long);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1200);
    // Consecutive chunks overlap, so a sentence across a boundary is in one of them whole.
    const tail = chunks[0]?.slice(-50) ?? "";
    expect(chunks[1]?.includes(tail.slice(-20))).toBe(true);
    expect(chunksOf("message", "", long).length).toBeLessThanOrEqual(16);
  });
});

describe("hybrid search", () => {
  it("finds a paraphrase that shares no words with the query, marked semantic", async () => {
    const { index, semantic } = semanticSetup();
    await index.indexMany([
      doc({ id: "m1", text: "How much can we spend in Lisbon next month?", threadId: "t1" }),
      doc({ id: "m2", text: "The dentist moved my appointment to Thursday", threadId: "t2" }),
    ]);
    await semantic.idle();
    expect(vectorCount(index.db)).toBe(2);

    const res = await index.search({ q: "trip budget" });
    expect(res.hits.map((h) => [h.id, h.match])).toEqual([["m1", "semantic"]]);
    expect(res.hits[0]?.snippet).toContain("Lisbon");
    expect(res.groups.find((g) => g.group === "threads")?.count).toBe(1);

    // Lexical-only finds nothing for it.
    index.setSemantic(undefined);
    expect((await index.search({ q: "trip budget" })).hits).toEqual([]);
  });

  it("marks a document both retrievers found and ranks it first", async () => {
    const { index, semantic } = semanticSetup();
    await index.indexMany([
      doc({ id: "a", text: "Lisbon trip budget: hotel and flights", threadId: "t1" }),
      doc({ id: "b", text: "Money for the holiday is tight this year", threadId: "t2" }),
    ]);
    await semantic.idle();
    const res = await index.search({ q: "lisbon budget" });
    expect(res.hits[0]).toMatchObject({ id: "a", match: "both" });
    expect(res.hits.find((h) => h.id === "b")?.match).toBe("semantic");
  });

  it("never shows a semantic hit outside the viewer's scope or the query's filters", async () => {
    const { index, semantic } = semanticSetup();
    await index.indexMany([
      doc({ id: "alice", text: "How much can we spend in Lisbon", scopeKey: "persona:alice" }),
      doc({ id: "task", kind: "task", text: "Travel money for the holiday" }),
    ]);
    await semantic.idle();
    const as = async (q: string, scopeKey?: string) =>
      (
        await index.search({
          q,
          ...(scopeKey === undefined ? {} : { viewer: { kind: "delegated", scopeKey } }),
        })
      ).hits.map((h) => h.id);
    expect((await as("trip budget")).sort()).toEqual(["alice", "task"]);
    expect(await as("trip budget", "persona:bob")).toEqual([]);
    expect(await as("trip budget", "persona:alice")).toEqual(["alice"]);
    expect(await as("in:tasks trip budget")).toEqual(["task"]);
    expect(await as("trip budget -holiday")).toEqual(["alice"]);
  });

  it("drops vectors with their document and re-embeds only changed documents", async () => {
    const { index, semantic, embedder } = semanticSetup();
    await index.index(doc({ id: "m1", text: "How much can we spend in Lisbon", updatedAt: 1 }));
    await semantic.idle();
    const documentCalls = () => embedder.calls.filter((c) => c.purpose === "document").length;
    expect(documentCalls()).toBe(1);
    // Same version: nothing to do.
    await index.index(doc({ id: "m1", text: "How much can we spend in Lisbon", updatedAt: 1 }));
    await semantic.idle();
    expect(documentCalls()).toBe(1);
    // Edited: re-embedded.
    await index.index(doc({ id: "m1", text: "How much can we spend in Porto", updatedAt: 2 }));
    await semantic.idle();
    expect(documentCalls()).toBe(2);
    // Removed (deleted thread, incognito): its vectors go with it.
    await index.remove("m1");
    expect(vectorCount(index.db)).toBe(0);
    expect((await index.search({ q: "trip budget" })).hits).toEqual([]);
  });

  it("switching model re-embeds and drops the old model's vectors", async () => {
    const { index, semantic } = semanticSetup();
    await index.index(doc({ id: "m1", text: "How much can we spend in Lisbon" }));
    await semantic.idle();
    semantic.setEmbedder(fakeEmbedder(GROUPS, { model: "fake/other", dims: 32 }));
    await semantic.idle();
    const models = index.db.prepare("SELECT DISTINCT model, dims FROM search_vectors").all();
    expect(models).toEqual([{ model: "fake/other", dims: 32 }]);
    expect(semantic.progress()).toMatchObject({ state: "ready", model: "fake/other", dims: 32 });
    expect((await index.search({ q: "trip budget" })).hits.map((h) => h.id)).toEqual(["m1"]);
  });

  it("falls back to lexical results when the query embedding is too slow", async () => {
    const { index } = setup();
    const semantic = new SemanticIndex(index.db, {
      floor: 0.5,
      sleep: noSleep,
      queryTimeoutMs: 20,
    });
    index.setSemantic(semantic);
    semantic.setEmbedder(fakeEmbedder(GROUPS, { queryDelayMs: 1000 }));
    await index.index(doc({ id: "m1", text: "Lisbon trip budget: hotel and flights" }));
    await semantic.idle();
    const res = await index.search({ q: "lisbon" });
    expect(res.hits.map((h) => h.id)).toEqual(["m1"]);
    expect(res.warnings).toContain("semantic_busy");
  });

  it("clear() drops every vector", async () => {
    const { index, semantic } = semanticSetup();
    await index.index(doc({ id: "m1", text: "How much can we spend in Lisbon" }));
    await semantic.idle();
    semantic.setEmbedder(undefined);
    semantic.clear();
    expect(vectorCount(index.db)).toBe(0);
  });
});
