import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting, openDb, setSetting } from "@psyche/db";
import { GraphStore } from "@psyche/memory";
import { EVERYTHING_MEMORY_SETTING_KEY } from "@psyche/protocol";
import { FakeClock, FakeModelProvider } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { composeEverything, everythingSettings } from "../src/compose/everything.ts";
import {
  parseBattery,
  parseIdleMinutes,
  parseLowPower,
  parseThermal,
  readSystemState,
} from "../src/compose/everything-probe.ts";

function makeTmpDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-em-")));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const NOW = Date.parse("2026-10-29T03:00:00Z");

function setup(
  over: {
    readState?: Parameters<typeof composeEverything>[0]["readState"];
    announce?: Parameters<typeof composeEverything>[0]["announce"];
  } = {},
) {
  const clock = new FakeClock(NOW);
  const db = openDb(":memory:");
  const graph = new GraphStore({ sqlite: db.sqlite, clock });
  const provider = new FakeModelProvider({ id: "fake" });
  const tmp = makeTmpDir();
  mkdirSync(join(tmp.dir, "state"), { recursive: true });
  const e = composeEverything({
    db,
    clock,
    graph,
    home: tmp.dir,
    provider,
    utility: "fake/utility",
    timeZone: () => "UTC",
    ...(over.readState === undefined ? {} : { readState: over.readState }),
    ...(over.announce === undefined ? {} : { announce: over.announce }),
  });
  return { clock, db, graph, provider, e, tmp };
}

describe("settings", () => {
  it("default to off, model None, two_way, sensitive off, accepted agent access", () => {
    const s = everythingSettings(undefined);
    expect(s).toMatchObject({
      enabled: false,
      model: { default: { kind: "none" } },
      people: { default: "two_way" },
      agentAccess: "accepted",
    });
    expect(Object.values(s.sensitive).some(Boolean)).toBe(false);
  });
  it("merges partial values and fails closed on a bad one", () => {
    expect(everythingSettings({ enabled: true, sources: { mail: true } })).toMatchObject({
      enabled: true,
      sources: { mail: true, messages: false },
    });
    const bad = everythingSettings({ enabled: true, model: { default: { kind: "remote" } } });
    expect(bad.enabled).toBe(false);
  });
});

describe("machine probe", () => {
  it("parses pmset and ioreg output", () => {
    expect(
      parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1) 87%; charging"),
    ).toEqual({ onAc: true, pct: 87 });
    expect(parseBattery("Now drawing from 'Battery Power'\n 41%; discharging")).toEqual({
      onAc: false,
      pct: 41,
    });
    expect(parseBattery("")).toBeUndefined();
    expect(parseLowPower(" lowpowermode         1\n")).toBe(true);
    expect(parseLowPower(" lowpowermode         0\n")).toBe(false);
    expect(parseThermal("CPU_Speed_Limit = 100")).toBe("nominal");
    expect(parseThermal("CPU_Speed_Limit = 60")).toBe("serious");
    expect(parseThermal("nothing")).toBe("nominal");
    expect(parseIdleMinutes('"HIDIdleTime" = 1200000000000')).toBe(20);
  });
  it("a failed read is not AC; a server is always on AC", async () => {
    const empty = async () => "";
    expect((await readSystemState("darwin", empty, () => 1)).onAc).toBe(false);
    expect((await readSystemState("linux", empty, () => 1)).onAc).toBe(true);
    const ok = async (_f: string, a: string[]) =>
      a[1] === "batt"
        ? "Now drawing from 'AC Power'\n 99%"
        : a[0] === "-c"
          ? '"HIDIdleTime" = 600000000000'
          : "";
    expect(await readSystemState("darwin", ok, () => 7)).toMatchObject({
      onAc: true,
      batteryPct: 99,
      idleMinutes: 10,
      freeMemBytes: 7,
      thermal: "nominal",
    });
  });
});

describe("handlers", () => {
  it("list, decide, undo, quarantine and runs go through the store", async () => {
    const { e, graph, db } = setup();
    graph.createEntity({ kind: "person", name: "The Owner", isOwner: true });
    const sam = graph.createEntity({ kind: "person", name: "Sam Lee" }).id;
    const cite = {
      source: "mail" as const,
      sourceRef: "<m>",
      quote: "I live in Rome",
      start: 0,
      end: 14,
      sourceHash: "h",
    };
    const out = e.store.proposeFact({
      entityId: sam,
      attribute: "city",
      value: "Rome",
      provenance: "untrusted",
      subjectKind: "self_disclosure",
      citations: [cite],
    });
    if (out.status === "refused") throw new Error("refused");
    const list = await e.handlers["memory.review.list"]({});
    expect(list.items).toHaveLength(1);
    expect(list.counts.pending).toBe(1);
    expect(list.nextCursor).toBeNull();
    await expect(
      e.handlers["memory.review.decide"]({ factIds: [out.fact.id], decision: "edit" }),
    ).rejects.toThrow(/needs one fact/);
    const done = await e.handlers["memory.review.decide"]({
      factIds: [out.fact.id],
      decision: "confirm",
    });
    expect(done.facts[0]).toMatchObject({ review: "accepted", provenance: "untrusted" });
    expect((await e.handlers["memory.review.list"]({})).items).toHaveLength(0);
    const q = e.store.quarantine({
      source: "mail",
      sourceRef: "<q>",
      reasons: ["hidden_text"],
      excerpt: "e",
    });
    expect((await e.handlers["memory.quarantine.list"]({})).items).toHaveLength(1);
    expect(
      (await e.handlers["memory.quarantine.decide"]({ id: q.id, action: "discard" })).item.decided,
    ).toBe("discarded");
    const run = e.store.startRun({ model: null, sources: [] });
    expect((await e.handlers["memory.runs.list"]({})).runs[0]?.id).toBe(run);
    expect(getSetting(db, EVERYTHING_MEMORY_SETTING_KEY)).toBeUndefined();
  });

  it("pages the queue with an opaque cursor", async () => {
    const { e, graph } = setup();
    const sam = graph.createEntity({ kind: "person", name: "Sam Lee" }).id;
    for (const [i, v] of ["a", "b", "c"].entries()) {
      e.store.proposeFact({
        entityId: sam,
        attribute: "likes",
        value: `thing ${v}`,
        provenance: "untrusted",
        subjectKind: "self_disclosure",
        citations: [
          {
            source: "mail",
            sourceRef: `<${i}>`,
            quote: `I like thing ${v}`,
            start: 0,
            end: 12,
            sourceHash: "h",
          },
        ],
      });
    }
    const p1 = await e.handlers["memory.review.list"]({ limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBe("2");
    const p2 = await e.handlers["memory.review.list"]({ limit: 2, cursor: "2" });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
  });
});

describe("the nightly step", () => {
  const night = async () => ({
    onAc: true,
    lowPowerMode: false,
    thermal: "nominal" as const,
    idleMinutes: 60,
  });

  it("does nothing while the feature is off, and never opens the search index or a model", async () => {
    const { e, provider } = setup({ readState: night });
    expect(await e.nightly()).toBeUndefined();
    expect(provider.requests).toHaveLength(0);
  });

  it("with the model None (the default) the gates refuse and nothing is read", async () => {
    const { e, db, provider } = setup({ readState: night });
    setSetting(db, EVERYTHING_MEMORY_SETTING_KEY, { enabled: true, sources: { mail: true } });
    expect(await e.nightly()).toBeUndefined();
    expect(provider.requests).toHaveLength(0);
    expect(e.store.runs()).toEqual([]);
  });

  it("a local model waits for the owner's confirmation of that exact model", async () => {
    const { e, db, graph, provider } = setup({ readState: night });
    graph.createEntity({ kind: "person", name: "The Owner", isOwner: true });
    setSetting(db, EVERYTHING_MEMORY_SETTING_KEY, {
      enabled: true,
      sources: { mail: true },
      model: { default: { kind: "local", ref: "ollama/qwen3:4b" } },
    });
    expect(await e.nightly()).toBeUndefined();
    setSetting(db, "memory.everything.localConfirmed", "ollama/other");
    expect(await e.nightly()).toBeUndefined();
    expect(provider.requests).toHaveLength(0);
  });

  it("on battery it waits, even with a cloud model", async () => {
    const { e, db, graph } = setup({
      readState: async () => ({
        onAc: false,
        batteryPct: 90,
        lowPowerMode: false,
        thermal: "nominal",
        idleMinutes: 60,
      }),
    });
    graph.createEntity({ kind: "person", name: "The Owner", isOwner: true });
    setSetting(db, EVERYTHING_MEMORY_SETTING_KEY, {
      enabled: true,
      sources: { mail: true },
      model: { default: { kind: "cloud" } },
    });
    expect(await e.nightly()).toBeUndefined();
  });

  it("a cloud model with the search index present runs, records a run and uses the utility model", async () => {
    const { e, db, graph, provider, tmp } = setup({ readState: night });
    graph.createEntity({ kind: "person", name: "The Owner", isOwner: true });
    const idx = openDb(join(tmp.dir, "state", "search.sqlite"), { migrate: false });
    idx.sqlite.exec(
      `CREATE TABLE search_docs (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, kind TEXT, grp TEXT, title TEXT NOT NULL, body TEXT NOT NULL, extra TEXT, provenance TEXT NOT NULL, thread_id TEXT, parent_id TEXT, collapse_key TEXT, scope_key TEXT NOT NULL, sender TEXT, sender_key TEXT, mime TEXT, tags TEXT, source TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)`,
    );
    idx.sqlite
      .prepare(
        `INSERT INTO search_docs (id, title, body, provenance, scope_key, source, created_ms, updated_ms) VALUES ('mail:1','','Note to self: remember to book the dentist on Friday.','owner','owner','connector:mail',?,?)`,
      )
      .run(NOW - 3600_000, NOW - 3600_000);
    idx.sqlite.close();
    provider.enqueue([
      { type: "text_delta", text: '{"facts":[],"edges":[],"flags":[]}' },
      { type: "finish", reason: "stop" },
    ]);
    setSetting(db, EVERYTHING_MEMORY_SETTING_KEY, {
      enabled: true,
      sources: { mail: true },
      model: { default: { kind: "cloud" } },
    });
    const line = await e.nightly();
    expect(line).toMatch(/^everything memory: 0 facts proposed from 1 items/);
    expect(provider.requests[0]?.model).toBe("fake/utility");
    expect(provider.requests[0]?.tools).toEqual([]);
    expect(e.store.runs()[0]).toMatchObject({ itemsRead: 1, model: "fake/utility" });
    tmp.cleanup();
  });
});

describe("the Feed card and the brief line", () => {
  const night = async () => ({
    onAc: true,
    lowPowerMode: false,
    thermal: "nominal" as const,
    idleMinutes: 60,
  });

  it("announces counts only, once, and the brief reads them for a day and a half", async () => {
    const cards: { title: string; bodyMd: string }[] = [];
    const { e, db, graph, provider, tmp, clock } = setup({
      readState: night,
      announce: (c) => cards.push(c),
    });
    graph.createEntity({ kind: "person", name: "The Owner", isOwner: true });
    graph.createEntity({ kind: "person", name: "Dana Reyes" });
    const idx = openDb(join(tmp.dir, "state", "search.sqlite"), { migrate: false });
    idx.sqlite.exec(
      `CREATE TABLE search_docs (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, kind TEXT, grp TEXT, title TEXT NOT NULL, body TEXT NOT NULL, extra TEXT, provenance TEXT NOT NULL, thread_id TEXT, parent_id TEXT, collapse_key TEXT, scope_key TEXT NOT NULL, sender TEXT, sender_key TEXT, mime TEXT, tags TEXT, source TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)`,
    );
    idx.sqlite
      .prepare(
        `INSERT INTO search_docs (id, title, body, provenance, scope_key, source, created_ms, updated_ms) VALUES ('mail:1','','Dana Reyes loves climbing, we should go this weekend.','owner','owner','connector:mail',?,?)`,
      )
      .run(NOW - 3600_000, NOW - 3600_000);
    idx.sqlite.close();
    const fact = {
      handle: "p1",
      attribute: "likes",
      value: "climbing",
      item: "i1",
      quote: "Dana Reyes loves climbing",
      start: 0,
      end: 25,
      subject_kind: "owner_stated",
      sensitivity: "none",
      confidence: 0.95,
    };
    provider.enqueue([
      { type: "text_delta", text: JSON.stringify({ facts: [fact], edges: [], flags: [] }) },
      { type: "finish", reason: "stop" },
    ]);
    setSetting(db, EVERYTHING_MEMORY_SETTING_KEY, {
      enabled: true,
      sources: { mail: true },
      model: { default: { kind: "cloud" } },
    });
    expect(await e.learnedYesterday()).toBeUndefined();
    await e.nightly();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.title).toBe("Psyche learned 1 thing");
    expect(cards[0]?.bodyMd).toBe(
      "1 auto-accepted · 0 to review · 0 quarantined\n\n[Review](/settings/memory)",
    );
    expect(JSON.stringify(cards)).not.toMatch(/climbing|Dana/);
    expect(e.learnedYesterday()).toEqual({
      text: "Psyche learned 1 thing yesterday: 1 auto-accepted · 0 to review · 0 quarantined",
      link: "/settings/memory",
    });
    clock.advance(40 * 3_600_000);
    expect(e.learnedYesterday()).toBeUndefined();
    tmp.cleanup();
  });

  it("announces nothing when the run found nothing", async () => {
    const cards: unknown[] = [];
    const { e, db, graph, provider, tmp } = setup({
      readState: night,
      announce: (c) => cards.push(c),
    });
    graph.createEntity({ kind: "person", name: "The Owner", isOwner: true });
    const idx = openDb(join(tmp.dir, "state", "search.sqlite"), { migrate: false });
    idx.sqlite.exec(
      `CREATE TABLE search_docs (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, kind TEXT, grp TEXT, title TEXT NOT NULL, body TEXT NOT NULL, extra TEXT, provenance TEXT NOT NULL, thread_id TEXT, parent_id TEXT, collapse_key TEXT, scope_key TEXT NOT NULL, sender TEXT, sender_key TEXT, mime TEXT, tags TEXT, source TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)`,
    );
    idx.sqlite
      .prepare(
        `INSERT INTO search_docs (id, title, body, provenance, scope_key, source, created_ms, updated_ms) VALUES ('mail:1','','Note to self: book the dentist for Friday.','owner','owner','connector:mail',?,?)`,
      )
      .run(NOW - 3600_000, NOW - 3600_000);
    idx.sqlite.close();
    provider.enqueue([
      { type: "text_delta", text: '{"facts":[],"edges":[],"flags":[]}' },
      { type: "finish", reason: "stop" },
    ]);
    setSetting(db, EVERYTHING_MEMORY_SETTING_KEY, {
      enabled: true,
      sources: { mail: true },
      model: { default: { kind: "cloud" } },
    });
    await e.nightly();
    expect(cards).toEqual([]);
    expect(e.learnedYesterday()).toBeUndefined();
    tmp.cleanup();
  });
});

describe("exclusion handlers", () => {
  it("list, add (with a forget dry run), remove, and the default for who is included", async () => {
    const { e, graph } = setup();
    const sam = graph.createEntity({
      kind: "person",
      name: "Sam Lee",
      identifiers: [{ kind: "email", value: "sam@acme.com" }],
    }).id;
    e.store.proposeFact({
      entityId: sam,
      attribute: "city",
      value: "Rome",
      provenance: "untrusted",
      subjectKind: "self_disclosure",
      citations: [
        {
          source: "mail",
          sourceRef: "<m>",
          quote: "I live in Rome",
          start: 0,
          end: 14,
          sourceHash: "h",
          authorEntityId: sam,
        },
      ],
    });
    expect(await e.handlers["memory.exclusions.list"]({})).toEqual({
      entries: [],
      defaultPeople: "two_way",
    });
    const dry = await e.handlers["memory.exclusions.add"]({
      kind: "domain",
      value: "acme.com",
      mode: "forget",
      dryRun: true,
    });
    expect(dry.forgotten).toMatchObject({ facts: 1 });
    expect((await e.handlers["memory.exclusions.list"]({})).entries).toEqual([]);
    const added = await e.handlers["memory.exclusions.add"]({ kind: "email", value: "priya@x.io" });
    expect(added.entry.hint).toBe("p•••@x.io");
    const listed = await e.handlers["memory.exclusions.list"]({});
    expect(listed.entries).toHaveLength(1);
    expect(await e.handlers["memory.exclusions.remove"]({ id: added.entry.id })).toEqual({
      removed: true,
    });
    expect((await e.handlers["memory.exclusions.list"]({})).entries).toEqual([]);
  });
});
