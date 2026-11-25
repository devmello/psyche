import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSetting } from "@psyche/db";
import { GraphIngester, type ItemReader, runEverythingPass } from "@psyche/memory";
import {
  EVERYTHING_MEMORY_DEFAULTS,
  EVERYTHING_MEMORY_SETTING_KEY,
  type EverythingMemorySettings,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
} from "@psyche/protocol";
import { FakeClock, FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { budgetedProvider } from "../src/compose/nightly-budget.ts";
import { GRAPH_SETTING } from "../src/compose/people.ts";
import { silentLogger } from "../src/log.ts";

/**
 * One nightly budget for the two model passes over the owner's memory (memory audit P8): the
 * extraction pass hands the tokens it leaves to the people-graph pass, which spends at most
 * that and skips the people the extraction pass already read about.
 */

const WORLD = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "..", "..", "tests", "fixtures", "graph", "world.json"),
    "utf8",
  ),
);
const NOW = Date.parse(WORLD.now);

let home = "";
let composed: ComposedGateway | null = null;
afterEach(async () => {
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

/** Every call replies with a graph summary and reports `used` tokens. */
const reply =
  (used: number) =>
  (_r: ModelRequest): ModelEvent[] => [
    {
      type: "text_delta",
      text: JSON.stringify({ summary: "Works with you.", facts: [], loops: [] }),
    },
    {
      type: "usage",
      usage: {
        input: used - 100,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        costUsd: 0,
      },
    },
    { type: "finish", reason: "stop" },
  ];

async function compose(perCall: number) {
  home = mkdtempSync(join(tmpdir(), "psyche-budget-"));
  const provider = FakeModelProvider.script(Array.from({ length: 200 }, () => reply(perCall)));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    timeZone: "UTC",
    clock: new FakeClock(NOW),
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider, model: "fake/model" },
  });
  const c = composed;
  const ingest = new GraphIngester(c.people.graph, {
    ownerEmails: WORLD.owner.emails,
    ownerPhones: WORLD.owner.phones,
    clock: new FakeClock(NOW),
  });
  ingest.ingestContacts(WORLD.contacts);
  ingest.ingestMail(WORLD.mails);
  ingest.ingestEvents(WORLD.events);
  ingest.ingestMessages(WORLD.messages);
  const graph = { enabled: true, model: { maxEntitiesPerNight: 50 } };
  setSetting(c.db, GRAPH_SETTING, graph);
  c.people.sync(graph);
  return { c, provider };
}

const text = (r: ModelRequest) =>
  r.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))).join("\n");

describe("budgetedProvider", () => {
  const inner = (used: number): ModelProvider & { calls: number } => {
    const p = FakeModelProvider.script(Array.from({ length: 20 }, () => reply(used)));
    const wrapped = Object.assign(p, { calls: 0 });
    const stream = p.stream.bind(p);
    p.stream = (...a) => {
      wrapped.calls++;
      return stream(...a);
    };
    return wrapped;
  };
  const ask = async (p: ModelProvider) => {
    const events: ModelEvent[] = [];
    for await (const e of p.stream({
      model: "x/y",
      system: "s",
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 800,
    } as never))
      events.push(e);
    return events;
  };

  it("refuses a call that could cross the limit and counts reported usage", async () => {
    const base = inner(1000);
    const b = budgetedProvider(base, 1700);
    expect((await ask(b)).at(-1)).toMatchObject({ reason: "stop" });
    expect(b.spent()).toBe(1000);
    // 1000 spent + 800 allowed output + the prompt would pass 2000: not sent.
    expect((await ask(b)).at(-1)).toMatchObject({ reason: "error" });
    expect(base.calls).toBe(1);
    expect(b.spent()).toBe(1000);
  });

  it("is a positive control: with room it sends every call", async () => {
    const base = inner(1000);
    const b = budgetedProvider(base, 100_000);
    for (let i = 0; i < 5; i++) await ask(b);
    expect(base.calls).toBe(5);
    expect(b.spent()).toBe(5000);
  });
});

describe("people.modelPass inside the shared budget", () => {
  it.each([900, 2500, 6000, 20_000])("spends at most %i tokens", async (left) => {
    const { c, provider } = await compose(1000);
    const r = await c.people.modelPass(left, new Set());
    expect(r.tokens).toBeLessThanOrEqual(left);
    expect(provider.requests.length * 1000).toBeLessThanOrEqual(left);
    // Positive control: with room for one call or more, the pass did run.
    if (left >= 2500) expect(provider.requests.length).toBeGreaterThan(0);
  });

  it("leaves the entities the extraction pass covered alone", async () => {
    const { c, provider } = await compose(1000);
    const pending = c.people.graph.pendingForModel(50);
    expect(pending.length).toBeGreaterThan(2);
    const coveredId = pending[0]?.id ?? "";
    const coveredName = c.people.graph.getEntity(coveredId)?.name ?? "";
    expect(coveredName).not.toBe("");
    await c.people.modelPass(1_000_000, new Set([coveredId]));
    expect(provider.requests.length).toBeGreaterThan(0);
    for (const r of provider.requests) expect(text(r)).not.toContain(`"name":"${coveredName}"`);
    // Control: without the exclusion the same entity gets a call.
    const second = await compose(1000);
    await second.c.people.modelPass(1_000_000, new Set());
    expect(second.provider.requests.some((r) => text(r).includes(`"name":"${coveredName}"`))).toBe(
      true,
    );
  });

  it("does nothing while the graph or its nightly model pass is off", async () => {
    const { c, provider } = await compose(1000);
    c.people.sync({ enabled: false });
    setSetting(c.db, GRAPH_SETTING, { enabled: false });
    expect(await c.people.modelPass(100_000, new Set())).toEqual({ tokens: 0 });
    setSetting(c.db, GRAPH_SETTING, { enabled: true, model: { nightly: false } });
    expect(await c.people.modelPass(100_000, new Set())).toEqual({ tokens: 0 });
    expect(provider.requests).toHaveLength(0);
  });
});

describe("one nightly budget across both passes", () => {
  const BUDGET = 6000;

  function emSettings(): EverythingMemorySettings {
    const base = structuredClone(EVERYTHING_MEMORY_DEFAULTS) as EverythingMemorySettings;
    return {
      ...base,
      enabled: true,
      sources: { ...base.sources, mail: true },
      model: { default: { kind: "cloud", ref: "fake/haiku" } },
      maxTokensPerNight: BUDGET,
    };
  }

  /** The extraction pass reads one owner item that names Sam Lee in full. */
  const reader: ItemReader = {
    read: (source) =>
      source !== "mail"
        ? { items: [], next: undefined, skippedUntrusted: 0, hasMore: false }
        : {
            items: [
              {
                trust: "owner",
                sender: null,
                source: "mail",
                docId: "doc-1",
                rowid: 1,
                title: "Plans",
                body: "Sam Lee and I talked about the Lisbon trip and the budget for it.",
                threadId: null,
                createdMs: NOW - 1000,
                updatedMs: NOW - 1000,
              },
            ],
            next: { updatedMs: NOW - 1000, rowid: 1 },
            skippedUntrusted: 0,
            hasMore: false,
          },
  };

  it("keeps extraction plus graph pass within the shared budget and skips what extraction covered", async () => {
    const { c, provider: pg } = await compose(1000);
    const emProvider = FakeModelProvider.script([
      [
        { type: "text_delta", text: JSON.stringify({ facts: [], edges: [], flags: [] }) },
        {
          type: "usage",
          usage: {
            input: 2000,
            output: 100,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            costUsd: 0,
          },
        },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const report = await runEverythingPass({
      graph: c.people.graph,
      em: c.people.em,
      sqlite: c.db.sqlite,
      reader,
      settings: emSettings(),
      state: { onAc: true, lowPowerMode: false, thermal: "nominal", idleMinutes: 60 },
      clock: new FakeClock(NOW),
      timeZone: "UTC",
      localMinutes: 3 * 60,
      modelFor: () => ({ provider: emProvider, model: "fake/haiku" }),
      graphModelPass: (left, covered) => c.people.modelPass(left, covered),
    });
    expect(report.error).toBeNull();
    const em = report.tokensIn + report.tokensOut;
    // The extraction pass's own call, then the graph pass on what was left.
    expect(emProvider.requests).toHaveLength(1);
    expect(pg.requests.length).toBeGreaterThan(0);
    expect(em).toBeLessThanOrEqual(BUDGET);
    // What the graph pass spent is its calls' reported tokens; the sum is the shared night's.
    const graphSpent = pg.requests.length * 1000;
    expect(2100 + graphSpent).toBeLessThanOrEqual(BUDGET);
    // Sam Lee, whom the extraction pass read about, got no graph-pass call.
    for (const r of pg.requests) expect(text(r)).not.toContain('"name":"Sam Lee"');
  });

  it("the graph pass's own nightly step leaves the model pass to everything memory's window", async () => {
    const { c, provider } = await compose(1000);
    // Everything memory is off: the graph step runs its own pass, as before.
    expect(c.everything.ownsGraphPass()).toBe(false);
    expect(await c.people.nightly()).toMatch(/^people graph: \d+ updated/);
    expect(provider.requests.length).toBeGreaterThan(0);

    const second = await compose(1000);
    setSetting(second.c.db, EVERYTHING_MEMORY_SETTING_KEY, {
      enabled: true,
      model: { default: { kind: "cloud", ref: "fake/haiku" } },
    });
    setSetting(second.c.db, "search.sources", { sources: { mail: { enabled: true } } });
    expect(second.c.everything.ownsGraphPass()).toBe(true);
    expect(await second.c.people.nightly()).toMatch(/runs with everything memory/);
    expect(second.provider.requests).toHaveLength(0);
  });
});
