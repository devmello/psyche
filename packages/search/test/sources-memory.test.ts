import { describe, expect, it } from "vitest";
import {
  defaultSourcesConfig,
  graphDocId,
  type MemoryRecord,
  memoryAdapter,
  memoryItem,
  readSourcesConfig,
  type SourceAdapter,
  SourceIndexer,
  type SourceItem,
  sourceTag,
} from "../src/index.ts";
import { NOW, setup } from "./helpers.ts";

const rec = (over: Partial<MemoryRecord> & { id: string; name: string }): MemoryRecord => ({
  kind: "person",
  aliases: [],
  facts: [],
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  ...over,
});

function harness(initial: MemoryRecord[], opts: { enabled?: boolean } = {}) {
  const { index } = setup();
  const world = {
    records: initial as readonly MemoryRecord[] | undefined,
    why: undefined as string | undefined,
  };
  const config = defaultSourcesConfig();
  config.sources.memory.enabled = opts.enabled ?? true;
  const indexer = new SourceIndexer(
    index,
    [memoryAdapter({ read: () => world.records, unavailable: () => world.why })],
    { config: () => config, now: () => NOW, pauseMs: 0 },
  );
  const ids = () =>
    (
      index.db
        .prepare("SELECT id FROM search_docs WHERE source = ? ORDER BY id")
        .all(sourceTag("memory")) as { id: string }[]
    ).map((r) => r.id);
  return { index, indexer, world, config, ids };
}

describe("the Memory source", () => {
  it("is off by default and owner-only for the agent, like Messages", () => {
    const c = defaultSourcesConfig().sources.memory;
    expect(c).toMatchObject({ enabled: false, agent: false });
    expect(
      readSourcesConfig({ sources: { memory: { enabled: true } } }).sources.memory,
    ).toMatchObject({
      enabled: true,
      agent: false,
    });
    // The owner can allow the agent, as with Messages.
    expect(
      readSourcesConfig({ sources: { memory: { enabled: true, agent: true } } }).sources.memory
        .agent,
    ).toBe(true);
    expect(defaultSourcesConfig().sources.notes.agent).toBe(true);
  });

  it("indexes people, projects, work due, events and facts, and finds them", async () => {
    const h = harness([
      rec({
        id: "p1",
        name: "Sam Lee",
        aliases: ["Sammy"],
        facts: [{ attribute: "employer", value: "Acme Robotics", provenance: "owner" }],
      }),
      rec({ id: "pr1", kind: "project", name: "Lisbon trip", status: "active" }),
      rec({
        id: "a1",
        kind: "assignment",
        name: "Submit visa form",
        status: "in_progress",
        dueAt: "2026-11-10T00:00:00Z",
        partOf: "Lisbon trip",
      }),
      rec({ id: "e1", kind: "event", name: "Maya's wedding", dueAt: "2026-12-05T17:00:00Z" }),
      rec({ id: "o1", kind: "org", name: "Acme Robotics" }),
    ]);
    await h.indexer.tick();
    expect(h.ids()).toEqual(["memory:a1", "memory:e1", "memory:o1", "memory:p1", "memory:pr1"]);
    for (const q of ["Acme Robotics", "visa form", "wedding", "Sammy"])
      expect((await h.index.search({ q })).hits.length, q).toBeGreaterThan(0);
    const visa = (await h.index.search({ q: "visa" })).hits[0];
    expect(visa?.createdAt).toBe(Date.parse("2026-11-10T00:00:00Z"));
    expect(h.indexer.status().sources.find((s) => s.id === "memory")).toMatchObject({
      items: 5,
      state: "idle",
      backfilled: true,
      label: "Memory",
    });
  });

  it("skips a bare person or project: their own document already holds the name", () => {
    expect(memoryItem(rec({ id: "p", name: "Nobody" }))).toBeUndefined();
    expect(memoryItem(rec({ id: "pr", kind: "project", name: "Bare" }))).toBeUndefined();
    expect(memoryItem(rec({ id: "t", kind: "topic", name: "Sourdough" }))).toBeDefined();
  });

  it("collapses a person's item onto the person's own document", () => {
    const item = memoryItem(
      rec({
        id: "p1",
        name: "Sam",
        facts: [{ attribute: "city", value: "Austin", provenance: "owner" }],
      }),
    );
    expect(item?.parentId).toBe(graphDocId("p1"));
    expect(
      memoryItem(rec({ id: "t", kind: "topic", name: "Sourdough" }))?.parentId,
    ).toBeUndefined();
  });

  it("marks an item the owner did not write as untrusted", () => {
    const owner = memoryItem(
      rec({
        id: "p1",
        name: "Sam",
        facts: [{ attribute: "city", value: "Austin", provenance: "owner" }],
      }),
    );
    const agent = memoryItem(
      rec({
        id: "p2",
        name: "Dana",
        facts: [{ attribute: "city", value: "Oslo", provenance: "agent" }],
      }),
    );
    expect(owner?.provenance).toBe("owner");
    expect(agent?.provenance).toBe("untrusted");
  });

  it("follows a changed fact and forgets what memory dropped, on the next pass", async () => {
    const h = harness([
      rec({
        id: "p1",
        name: "Sam Lee",
        facts: [{ attribute: "city", value: "Austin", provenance: "owner" }],
      }),
      rec({ id: "t1", kind: "topic", name: "Sourdough" }),
    ]);
    await h.indexer.tick();
    expect((await h.index.search({ q: "Austin" })).hits).toHaveLength(1);
    // Sam moves; the topic is hidden, made private or forgotten.
    h.world.records = [
      rec({
        id: "p1",
        name: "Sam Lee",
        facts: [{ attribute: "city", value: "Denver", provenance: "owner" }],
      }),
    ];
    await h.indexer.tick();
    expect(h.ids()).toEqual(["memory:p1"]);
    expect((await h.index.search({ q: "Austin" })).hits).toHaveLength(0);
    expect((await h.index.search({ q: "Denver" })).hits).toHaveLength(1);
    // Memory emptied (forget everything): the index is too.
    h.world.records = [];
    await h.indexer.tick();
    expect(h.ids()).toEqual([]);
  });

  it("reads nothing while memory is unavailable, and keeps what it has", async () => {
    const h = harness([rec({ id: "t1", kind: "topic", name: "Sourdough" })]);
    await h.indexer.tick();
    h.world.why = "memory is off";
    h.world.records = undefined;
    await h.indexer.tick();
    expect(h.ids()).toEqual(["memory:t1"]);
    expect(h.indexer.status().sources.find((s) => s.id === "memory")).toMatchObject({
      state: "unavailable",
      detail: "memory is off",
    });
  });

  it("is not read while off, and switching it off removes its documents at once", async () => {
    const off = harness([rec({ id: "t1", kind: "topic", name: "Sourdough" })], { enabled: false });
    await off.indexer.tick();
    expect(off.ids()).toEqual([]);

    const h = harness([rec({ id: "t1", kind: "topic", name: "Sourdough" })]);
    await h.indexer.tick();
    expect(h.ids()).toHaveLength(1);
    h.config.sources.memory.enabled = false;
    await h.indexer.applyConfig();
    expect(h.ids()).toEqual([]);
  });

  it("Rebuild reads it again from the start", async () => {
    const h = harness([rec({ id: "t1", kind: "topic", name: "Sourdough" })]);
    await h.indexer.tick();
    await h.indexer.rebuild("memory");
    expect(h.ids()).toEqual([]);
    await h.indexer.kick();
    expect(h.ids()).toEqual(["memory:t1"]);
  });

  it("the owner's never-index list applies: a person kept out, by address, is not indexed", async () => {
    const h = harness([
      rec({
        id: "p1",
        name: "Sam Lee",
        identifiers: ["sam@example.com"],
        facts: [{ attribute: "city", value: "Austin", provenance: "owner" }],
      }),
      rec({
        id: "p2",
        name: "Dana Reyes",
        facts: [{ attribute: "city", value: "Oslo", provenance: "owner" }],
      }),
    ]);
    h.config.exclude.contacts = ["sam@example.com"];
    await h.indexer.tick();
    expect(h.ids()).toEqual(["memory:p2"]);
    // Added later: what is indexed already goes.
    const later = harness([
      rec({ id: "p1", name: "Sam Lee", identifiers: ["sam@example.com"], aliases: ["Sammy"] }),
    ]);
    await later.indexer.tick();
    expect(later.ids()).toEqual(["memory:p1"]);
    later.config.exclude.contacts = ["Sammy"];
    await later.indexer.applyConfig();
    expect(later.ids()).toEqual([]);
  });
});

describe("what the manager does for Memory", () => {
  it("a person or project's link changing re-records who it is about, though its text did not change", async () => {
    const { index } = setup();
    let parties: string[] = [];
    const item = (): SourceItem => ({
      nativeId: "p1",
      title: "Lisbon trip",
      text: "Project: Lisbon trip",
      createdAt: NOW,
      provenance: "owner",
      parties,
    });
    const adapter: SourceAdapter = {
      id: "memory",
      unavailable: () => undefined,
      pull: async () => ({ items: [item()], cursor: null, hasMore: false, snapshot: true }),
    };
    const config = defaultSourcesConfig();
    config.sources.memory.enabled = true;
    const indexer = new SourceIndexer(index, [adapter], {
      config: () => config,
      now: () => NOW,
      pauseMs: 0,
    });
    const docs = () =>
      (
        index.db
          .prepare("SELECT id FROM search_docs WHERE source = ?")
          .all(sourceTag("memory")) as unknown[]
      ).length;
    await indexer.tick();
    expect(docs()).toBe(1);
    // Sam is linked to the project afterwards: same text, new party.
    parties = ["sam@example.com"];
    await indexer.tick();
    config.exclude.contacts = ["sam@example.com"];
    await indexer.applyConfig();
    expect(docs()).toBe(0);
  });

  it("runs in Low Power Mode, so what memory dropped leaves at once, and nothing else does", async () => {
    const { index } = setup();
    let records: MemoryRecord[] = [rec({ id: "t1", kind: "topic", name: "Sourdough" })];
    let pulls = 0;
    const notes: SourceAdapter = {
      id: "notes",
      unavailable: () => undefined,
      pull: async () => {
        pulls += 1;
        return { items: [], cursor: null, hasMore: false };
      },
    };
    const config = defaultSourcesConfig();
    config.sources.memory.enabled = true;
    config.sources.notes.enabled = true;
    let lowPower = false;
    const indexer = new SourceIndexer(
      index,
      [memoryAdapter({ read: () => records, unavailable: () => undefined }), notes],
      {
        config: () => config,
        now: () => NOW,
        pauseMs: 0,
        power: () => ({ onBattery: false, lowPower }),
      },
    );
    const ids = () =>
      (
        index.db
          .prepare("SELECT id FROM search_docs WHERE source = ?")
          .all(sourceTag("memory")) as { id: string }[]
      ).map((r) => r.id);
    await indexer.tick();
    expect(ids()).toEqual(["memory:t1"]);
    expect(pulls).toBe(1);
    lowPower = true;
    records = [];
    await indexer.tick();
    expect(ids()).toEqual([]);
    // Notes waited.
    expect(pulls).toBe(1);
  });

  it("reports why Memory cannot be switched on or opened to the agent", () => {
    const { index } = setup();
    const config = defaultSourcesConfig();
    const indexer = new SourceIndexer(
      index,
      [
        memoryAdapter({
          read: () => [],
          unavailable: () => undefined,
          blocked: () => "Turn on search index encryption first",
          agentBlocked: () => "Memory's agent access is set to none",
        }),
      ],
      { config: () => config, now: () => NOW },
    );
    const st = indexer.status().sources.find((x) => x.id === "memory");
    expect(st).toMatchObject({
      enabled: false,
      state: "off",
      cannotEnable: "Turn on search index encryption first",
      cannotAgent: "Memory's agent access is set to none",
    });
    // The others say nothing.
    expect(indexer.status().sources.find((x) => x.id === "notes")?.cannotEnable).toBeUndefined();
  });
});
