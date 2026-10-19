import { FakeClock, FakeMemoryStore } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { createSearchIndex } from "../src/index.ts";
import { DAY, doc, NOW, setup } from "./helpers.ts";

describe("ranking", () => {
  it("ranks title matches above body matches and stems words", async () => {
    const { index } = setup();
    await index.index(doc({ id: "body", text: "we talked about the dentist appointment" }));
    await index.index(doc({ id: "title", title: "Dentist", text: "call on monday" }));
    const r = await index.query({ q: "dentists" });
    expect(r.hits.map((h) => h.id)).toEqual(["title", "body"]);
  });

  it("boosts recent documents over equally relevant old ones", async () => {
    const { index } = setup();
    await index.index(doc({ id: "old", text: "quarterly tax estimate", createdAt: NOW - 400 * DAY }));
    await index.index(doc({ id: "new", text: "quarterly tax estimate", createdAt: NOW - DAY }));
    await index.index(doc({ id: "mid", text: "quarterly tax estimate", createdAt: NOW - 40 * DAY }));
    const r = await index.query({ q: "tax" });
    expect(r.hits.map((h) => h.id)).toEqual(["new", "mid", "old"]);
    expect(r.hits[0]?.score ?? 0).toBeGreaterThan(r.hits[2]?.score ?? 0);
  });

  it("recency does not beat a much better text match", async () => {
    const { index } = setup();
    await index.index(
      doc({ id: "strong", title: "Lisbon trip", text: "Lisbon flights Lisbon hotel", createdAt: NOW - 200 * DAY }),
    );
    await index.index(
      doc({ id: "weak", text: `${"filler words here ".repeat(60)} lisbon`, createdAt: NOW - DAY }),
    );
    expect((await index.query({ q: "lisbon" })).hits[0]?.id).toBe("strong");
  });

  it("matches the last word as a prefix and folds diacritics", async () => {
    const { index } = setup();
    await index.index(doc({ id: "a", text: "Café Résumé review" }));
    expect((await index.query({ q: "resume" })).hits.map((h) => h.id)).toEqual(["a"]);
    expect((await index.query({ q: "revi" })).hits.map((h) => h.id)).toEqual(["a"]);
    expect((await index.query({ q: "revi " })).hits).toHaveLength(0);
  });

  it("supports phrases, OR and exclusions", async () => {
    const { index } = setup();
    await index.index(doc({ id: "1", text: "three slots work for me" }));
    await index.index(doc({ id: "2", text: "slots three are open" }));
    await index.index(doc({ id: "3", text: "the doctor cancelled" }));
    expect((await index.query({ q: '"three slots"' })).hits.map((h) => h.id)).toEqual(["1"]);
    expect((await index.query({ q: "slots OR doctor" })).total).toBe(3);
    expect((await index.query({ q: "slots -open" })).hits.map((h) => h.id)).toEqual(["1"]);
    expect((await index.query({ q: "-open" })).hits.map((h) => h.id).sort()).toEqual(["1", "3"]);
  });
});

describe("filters", () => {
  const fixtures = async () => {
    const { index } = setup();
    await index.indexMany([
      doc({ id: "feed1", kind: "feed", text: "dentist news", provenance: "untrusted", createdAt: NOW - 3 * DAY }),
      doc({ id: "pdf1", kind: "library", title: "dentist-form.pdf", text: "dentist form", mime: "application/pdf", from: "Alice Chen <alice@example.com>", createdAt: NOW - 10 * DAY }),
      doc({ id: "img1", kind: "library", title: "xray.png", text: "dentist xray", mime: "image/png", createdAt: NOW - 20 * DAY }),
      doc({ id: "m1", kind: "message", threadId: "T1", text: "book the dentist", from: "bob@example.com", createdAt: NOW - 40 * DAY }),
      doc({ id: "t1", kind: "task", text: "dentist booking", createdAt: NOW - 2 * DAY }),
    ]);
    return index;
  };
  const ids = async (index: Awaited<ReturnType<typeof fixtures>>, q: string) =>
    (await index.query({ q })).hits.map((h) => h.id).sort();

  it("in:, type:, from:", async () => {
    const index = await fixtures();
    expect(await ids(index, "dentist in:feed")).toEqual(["feed1"]);
    expect(await ids(index, "dentist in:library type:pdf")).toEqual(["pdf1"]);
    expect(await ids(index, "dentist type:image")).toEqual(["img1"]);
    expect(await ids(index, "dentist from:alice")).toEqual(["pdf1"]);
    expect(await ids(index, "dentist from:ALICE@EXAMPLE")).toEqual(["pdf1"]);
    expect(await ids(index, "dentist from:bob in:threads")).toEqual(["m1"]);
  });

  it("before:, after:, is:, thread:", async () => {
    const index = await fixtures();
    expect(await ids(index, "dentist after:7d")).toEqual(["feed1", "t1"]);
    expect(await ids(index, "dentist before:2026-09-25")).toEqual(["m1"]);
    expect(await ids(index, "dentist is:untrusted")).toEqual(["feed1"]);
    expect(await ids(index, "thread:T1")).toEqual(["m1"]);
  });

  it("has:approval matches documents, their thread or their parent task", async () => {
    const index = await fixtures();
    await index.index(doc({ id: "a1", kind: "task", parentId: "t1", text: "drafted reply" }));
    await index.setFlag("t1", "approval");
    await index.setFlag("T1", "approval");
    expect(await ids(index, "has:approval")).toEqual(["a1", "m1", "t1"]);
    expect(await ids(index, "has:approval in:tasks")).toEqual(["a1", "t1"]);
    expect(await ids(index, "has:receipt")).toEqual([]);
  });

  it("filter-only queries list newest first", async () => {
    const index = await fixtures();
    const r = await index.query({ q: "in:library" });
    expect(r.hits.map((h) => h.id)).toEqual(["pdf1", "img1"]);
  });

  it("contract filters (kinds, from, threadId, before/after) still apply", async () => {
    const index = await fixtures();
    const r = await index.query({
      q: "dentist",
      filters: { kinds: ["library"], after: NOW - 15 * DAY, before: NOW },
    });
    expect(r.hits.map((h) => h.id)).toEqual(["pdf1"]);
  });
});

describe("permission scoping", () => {
  it("never stores incognito documents and deletes the old row", async () => {
    const { index } = setup();
    await index.index(doc({ id: "x", text: "okapi" }));
    await index.index(doc({ id: "x", text: "okapi", incognito: true }));
    expect(await index.count()).toBe(0);
    expect((await index.search({ q: "okapi" })).total).toBe(0);
  });

  it("a delegated viewer sees only its own scope and never memory", async () => {
    const clock = new FakeClock(NOW);
    const memory = new FakeMemoryStore({ clock });
    await memory.appendDailyNote({ text: "partner likes sushi", provenance: "owner" });
    const index = createSearchIndex({ now: () => clock.now(), memory });
    await index.index(doc({ id: "own", text: "sushi place for the owner" }));
    await index.index(doc({ id: "p1", text: "sushi with partner", scopeKey: "imessage:peer:partner" }));
    await index.index(doc({ id: "g1", text: "sushi for the group", scopeKey: "telegram:group:9" }));
    const owner = await index.search({ q: "sushi" });
    expect(owner.hits.map((h) => h.id).sort()).toEqual(["g1", "own", "p1", expect.stringMatching(/.+/)].sort());
    expect(owner.groups.map((g) => g.group)).toEqual(["threads", "memory"]);
    const partner = await index.search({
      q: "sushi",
      viewer: { kind: "delegated", scopeKey: "imessage:peer:partner" },
    });
    expect(partner.hits.map((h) => h.id)).toEqual(["p1"]);
    expect(partner.groups.map((g) => g.group)).toEqual(["threads"]);
  });
});

describe("grouped search", () => {
  it("collapses messages onto threads and actions onto tasks, with counts", async () => {
    const { index } = setup();
    await index.indexMany([
      doc({ id: "T1", kind: "thread", threadId: "T1", title: "Dentist booking", text: "Dentist booking" }),
      doc({ id: "m1", kind: "message", threadId: "T1", title: "Dentist booking", text: "three slots work for the dentist" }),
      doc({ id: "m2", kind: "message", threadId: "T1", title: "Dentist booking", text: "dentist confirmed" }),
      doc({ id: "m3", kind: "message", threadId: "T2", title: "Other", text: "dentist bill" }),
      doc({ id: "k1", kind: "task", title: "Book dentist", text: "book the dentist" }),
      doc({ id: "k1a", kind: "task", parentId: "k1", title: "Book dentist", text: "opened dentist site" }),
      doc({ id: "L1", kind: "library", title: "permission-slip.pdf", text: "dentist consent" }),
    ]);
    const r = await index.search({ q: "dentist" });
    const threads = r.groups.find((g) => g.group === "threads");
    expect(threads?.count).toBe(2);
    expect(threads?.hits.map((h) => h.threadId).sort()).toEqual(["T1", "T2"]);
    expect(r.groups.find((g) => g.group === "tasks")?.count).toBe(1);
    expect(r.groups.map((g) => g.group)).toEqual(["threads", "tasks", "library"]);
    expect(r.total).toBe(4);
    expect(r.hits).toHaveLength(4);
  });

  it("returns highlights as ranges over plain snippets", async () => {
    const { index } = setup();
    await index.index(doc({ id: "a", title: "Dentist visit", text: "The dentist said three slots work." }));
    const [hit] = (await index.search({ q: "dentist" })).hits;
    expect(hit?.snippet).not.toMatch(/[\u0002\u0003]/);
    const [s, e] = hit?.snippetHighlights[0] ?? [0, 0];
    expect(hit?.snippet.slice(s, e).toLowerCase()).toBe("dentist");
    expect(hit?.titleHighlights).toEqual([[0, 7]]);
  });

  it("limits groups and the flat list independently", async () => {
    const { index } = setup();
    await index.indexMany(
      Array.from({ length: 30 }, (_, i) => doc({ id: `n${i}`, kind: "feed", text: `kiwi ${i}` })),
    );
    const r = await index.search({ q: "kiwi", limit: 12, groupLimit: 3 });
    expect(r.hits).toHaveLength(12);
    expect(r.groups[0]?.hits).toHaveLength(3);
    expect(r.groups[0]?.count).toBe(30);
  });

  it("fuses memory hits with local hits and drops memory for filters it cannot satisfy", async () => {
    const clock = new FakeClock(NOW);
    const memory = new FakeMemoryStore({ clock });
    await memory.appendDailyNote({ text: "prefers morning dentist appointments", provenance: "owner" });
    const index = createSearchIndex({ now: () => clock.now(), memory });
    await index.index(doc({ id: "m1", text: "dentist booking", from: "alice" }));
    const r = await index.search({ q: "dentist" });
    const mem = r.groups.find((g) => g.group === "memory")?.hits[0];
    expect(mem).toMatchObject({ kind: "memory", provenance: "owner", sourcePath: expect.stringMatching(/^memory\//) });
    expect(r.hits.map((h) => h.kind).sort()).toEqual(["memory", "message"]);
    for (let i = 1; i < r.hits.length; i += 1) {
      expect(r.hits[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(r.hits[i]?.score ?? 0);
    }
    expect((await index.search({ q: "dentist from:alice" })).groups.map((g) => g.group)).toEqual(["threads"]);
    expect((await index.search({ q: "dentist in:memory" })).groups.map((g) => g.group)).toEqual(["memory"]);
    expect((await index.search({ q: "dentist is:untrusted" })).total).toBe(0);
    expect((await index.search({ q: "dentist before:2026-01-01" })).total).toBe(0);
  });

  it("removes threads, sources and single documents", async () => {
    const { index } = setup();
    await index.indexMany([
      doc({ id: "T9", kind: "thread", threadId: "T9", text: "plan" }),
      doc({ id: "m9", kind: "message", threadId: "T9", text: "plan" }),
      doc({ id: "c1", kind: "connector", source: "connector:gmail", text: "plan" }),
      doc({ id: "keep", text: "plan" }),
    ]);
    expect(await index.removeThread("T9")).toBe(2);
    expect(await index.removeSource("connector:gmail")).toBe(1);
    await index.remove("keep");
    expect(await index.count()).toBe(0);
  });
});
