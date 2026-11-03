import { openDb, setSetting } from "@psyche/db";
import { EverythingStore, GraphStore } from "@psyche/memory";
import {
  EVERYTHING_READABLE_SOURCES,
  effectiveEverythingSources,
  everythingOptOut,
} from "@psyche/protocol";
import {
  createSearchIndex,
  defaultSourcesConfig,
  memoryAdapter,
  SourceIndexer,
  sourceTag,
} from "@psyche/search";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { everythingSettings, indexedSources } from "../src/compose/everything.ts";
import { memoryRecords, memorySourceDeps } from "../src/compose/search-memory.ts";

const NOW = Date.parse("2026-11-03T09:00:00Z");

const cite = (ref: string) => ({
  source: "mail" as const,
  sourceRef: ref,
  quote: "quoted words",
  start: 0,
  end: 12,
  sourceHash: "h",
});

/** A graph with one of everything the Memory source must keep out, and what it may take. */
function world() {
  const clock = new FakeClock(NOW);
  const db = openDb(":memory:");
  const graph = new GraphStore({ sqlite: db.sqlite, clock });
  const em = new EverythingStore({ sqlite: db.sqlite, graph, clock });
  graph.createEntity({ kind: "person", name: "The Owner", isOwner: true });

  const sam = graph.createEntity({
    kind: "person",
    name: "Sam Lee",
    aliases: ["Sammy"],
    identifiers: [{ kind: "email", value: "sam@example.com" }],
  }).id;
  // Reviewed and plain: indexed.
  graph.setFact({
    entityId: sam,
    attribute: "employer",
    value: "Acme Robotics",
    provenance: "owner",
  });
  // Waiting for review: never.
  em.proposeFact({
    entityId: sam,
    attribute: "city",
    value: "Pending City",
    provenance: "agent",
    subjectKind: "about_other",
    citations: [cite("<1>")],
  });
  // Reviewed, but sensitive: never.
  const health = em.proposeFact({
    entityId: sam,
    attribute: "likes",
    value: "Sensitive Condition",
    provenance: "agent",
    subjectKind: "about_other",
    sensitivity: "health",
    citations: [cite("<2>")],
  });
  if (health.status === "pending") em.decide(health.fact.id, "confirm");
  // Reviewed, but written by a third party: never.
  const stranger = em.proposeFact({
    entityId: sam,
    attribute: "school",
    value: "Untrusted Academy",
    provenance: "untrusted",
    subjectKind: "about_other",
    citations: [cite("<3>")],
  });
  if (stranger.status === "pending") em.decide(stranger.fact.id, "confirm");

  const hidden = graph.createEntity({ kind: "person", name: "Hidden Hank" }).id;
  graph.setFact({
    entityId: hidden,
    attribute: "employer",
    value: "Hidden Corp",
    provenance: "owner",
  });
  graph.updateEntity(hidden, { hidden: true });

  const secret = graph.createEntity({ kind: "project", name: "Secret Plan", private: true }).id;
  const trip = graph.createEntity({
    kind: "project",
    name: "Lisbon trip",
    projectStatus: "active",
  }).id;
  const visa = graph.createEntity({
    kind: "assignment",
    name: "Submit visa form",
    dueAt: "2026-11-10T00:00:00Z",
  }).id;
  graph.setEdge({ src: visa, rel: "part_of", dst: trip, provenance: "owner" });
  const hush = graph.createEntity({ kind: "assignment", name: "Quiet task" }).id;
  graph.setEdge({ src: hush, rel: "part_of", dst: secret, provenance: "owner" });
  graph.createEntity({ kind: "event", name: "Maya's wedding", dueAt: "2026-12-05T17:00:00Z" });
  return { graph, em, db, sam, hidden, secret };
}

describe("what the Memory source may index", () => {
  it("takes reviewed, non-sensitive, first-hand facts and nothing else", () => {
    const { graph, sam } = world();
    // The fixture's sensitive and third-party facts really are accepted: only the filter keeps
    // them out, and the waiting one is not current at all.
    const known = graph.facts(sam).map((f) => f.value);
    expect(known).toEqual(
      expect.arrayContaining(["Acme Robotics", "Sensitive Condition", "Untrusted Academy"]),
    );
    expect(known).not.toContain("Pending City");
    const records = memoryRecords(graph);
    const text = JSON.stringify(records);
    expect(text).toContain("Acme Robotics");
    for (const never of [
      "Pending City",
      "Sensitive Condition",
      "Untrusted Academy",
      "Hidden Hank",
      "Hidden Corp",
      "Secret Plan",
    ])
      expect(text, never).not.toContain(never);
    const names = records.map((r) => r.name).sort();
    expect(names).toEqual([
      "Lisbon trip",
      "Maya's wedding",
      "Quiet task",
      "Sam Lee",
      "Submit visa form",
      "The Owner",
    ]);
  });

  it("names the project a to-do is part of, unless that project is private", () => {
    const { graph } = world();
    const records = memoryRecords(graph);
    expect(records.find((r) => r.name === "Submit visa form")?.partOf).toBe("Lisbon trip");
    expect(records.find((r) => r.name === "Quiet task")?.partOf).toBeNull();
  });

  it("carries a person's addresses so the never-index list applies", () => {
    const { graph } = world();
    expect(memoryRecords(graph).find((r) => r.name === "Sam Lee")?.identifiers).toEqual([
      "sam@example.com",
    ]);
  });

  it("indexes through the source, finds it, and drops it when it is hidden, retracted or off", async () => {
    const { graph, sam, secret } = world();
    const index = createSearchIndex();
    let on = true;
    const config = defaultSourcesConfig();
    config.sources.memory.enabled = true;
    const indexer = new SourceIndexer(
      index,
      [memoryAdapter(memorySourceDeps({ graph: () => (on ? graph : undefined) }))],
      { config: () => config, now: () => NOW, pauseMs: 0 },
    );
    const docs = () =>
      (
        index.db
          .prepare("SELECT title, body FROM search_docs WHERE source = ? ORDER BY title")
          .all(sourceTag("memory")) as { title: string; body: string }[]
      ).map((d) => `${d.title}\n${d.body}`);

    await indexer.tick();
    const all = docs().join("\n---\n");
    expect(all).toContain("Acme Robotics");
    expect(all).toContain("Submit visa form");
    expect(all).toContain("Part of: Lisbon trip");
    expect(all).not.toMatch(
      /Pending City|Sensitive Condition|Untrusted Academy|Secret Plan|Hidden/,
    );
    expect((await index.search({ q: "Acme Robotics" })).hits.length).toBeGreaterThan(0);
    expect((await index.search({ q: "Pending City" })).hits).toHaveLength(0);

    // A fact is retracted: it leaves the index on the next pass, not at the nightly sweep.
    const employer = graph.facts(sam).find((f) => f.attribute === "employer");
    graph.retractFact(employer?.id as string);
    await indexer.tick();
    expect((await index.search({ q: "Acme Robotics" })).hits).toHaveLength(0);

    // A project is made private after it was indexed (it was not: it is private from the start);
    // a person is hidden: they go too.
    graph.updateEntity(sam, { hidden: true });
    await indexer.tick();
    expect(docs().join("\n")).not.toContain("Sam Lee");
    expect(secret).toBeTruthy();

    // Memory switched off: nothing stays indexed.
    on = false;
    await indexer.tick();
    expect(docs()).toEqual([]);
  });

  it("waits while the memory store is still opening", () => {
    const { graph } = world();
    let ready = false;
    const deps = memorySourceDeps({ graph: () => graph, ready: () => ready });
    expect(deps.unavailable()).toBe("Memory is still opening");
    expect(deps.read()).toBeUndefined();
    ready = true;
    expect(deps.unavailable()).toBeUndefined();
    expect(deps.read()?.length).toBeGreaterThan(0);
  });
});

describe("memory does not learn from its own index", () => {
  it("is not a source the nightly pass can read, however Search is set", () => {
    expect((EVERYTHING_READABLE_SOURCES as readonly string[]).includes("memory")).toBe(false);
    const effective = effectiveEverythingSources(everythingOptOut({}), ["mail", "notes", "memory"]);
    expect(Object.keys(effective)).not.toContain("memory");
    expect(effective.mail && effective.notes).toBe(true);
  });

  it("everything memory's settings never list it, even with Memory switched on in Search", () => {
    const db = openDb(":memory:");
    setSetting(db, "search.sources", { sources: { memory: { enabled: true } } });
    expect(indexedSources(db)).toContain("memory");
    const s = everythingSettings(undefined, indexedSources(db));
    expect(Object.keys(s.sources)).not.toContain("memory");
    expect(Object.values(s.sources).some(Boolean)).toBe(false);
  });
});
