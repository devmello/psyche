import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRunContext } from "@psyche/agent-core";
import { setSetting } from "@psyche/db";
import { GraphIngester, isDreamingAutomation } from "@psyche/memory";
import type { ModelEvent } from "@psyche/protocol";
import { SqliteSearchIndex } from "@psyche/search";
import { FakeClock, FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { GRAPH_SETTING, graphSettings } from "../src/compose/people.ts";
import { silentLogger } from "../src/log.ts";

const WORLD = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "..", "..", "tests", "fixtures", "graph", "world.json"),
    "utf8",
  ),
);
const TOOLS = ["people_lookup", "project_brief", "waiting_on", "meeting_prep", "loop_update"];

let home = "";
let composed: ComposedGateway | null = null;

afterEach(async () => {
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

async function compose(replies: ModelEvent[][] = []): Promise<ComposedGateway> {
  home = mkdtempSync(join(tmpdir(), "psyche-people-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    timeZone: "UTC",
    clock: new FakeClock(Date.parse(WORLD.now)),
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: FakeModelProvider.script(replies), model: "fake/model" },
  });
  return composed;
}

function load(c: ComposedGateway) {
  const ingest = new GraphIngester(c.people.graph, {
    ownerEmails: WORLD.owner.emails,
    ownerPhones: WORLD.owner.phones,
    clock: new FakeClock(Date.parse(WORLD.now)),
  });
  ingest.ingestContacts(WORLD.contacts);
  ingest.ingestMail(WORLD.mails);
  ingest.ingestEvents(WORLD.events);
  ingest.ingestMessages(WORLD.messages);
}

function enable(c: ComposedGateway, value: Record<string, unknown> = { enabled: true }) {
  setSetting(c.db, GRAPH_SETTING, value);
  c.people.sync(value);
}

const ctx = (threadId: string, extra: Partial<ToolRunContext> = {}): ToolRunContext =>
  ({
    callId: "c1",
    threadId,
    runId: "r1",
    taint: false,
    permissionMode: "balanced",
    mode: "attended",
    signal: new AbortController().signal,
    onUpdate: () => {},
    ...extra,
  }) as ToolRunContext;

const byName = (c: ComposedGateway, name: string) =>
  c.people.graph.search(name, { limit: 10 }).find((s) => s.name === name)?.id ?? "";

describe("people and projects graph in the Gateway (#651)", () => {
  it("defaults to off: no agent tools until memory.graph.enabled, and they go when it is off", async () => {
    const c = await compose();
    expect(graphSettings(undefined)).toMatchObject({
      enabled: false,
      sources: { contacts: false, mail: false, chats: false },
      entityRecall: true,
      model: { nightly: true, maxEntitiesPerNight: 200, maxTokensPerNight: 150_000 },
    });
    for (const name of TOOLS) expect(c.loop.registry.get(name)).toBeUndefined();
    enable(c);
    for (const name of TOOLS) expect(c.loop.registry.get(name)).toBeDefined();
    expect(c.loop.registry.get("people_lookup")?.spec.sideEffect).toBe("none");
    expect(c.loop.registry.get("loop_update")?.spec.sideEffect).toBe("write");
    c.people.sync({ enabled: false });
    for (const name of TOOLS) expect(c.loop.registry.get(name)).toBeUndefined();
    // The owner's handlers are mounted either way, and the dreaming automation exists.
    const status = await c.people.handlers["memory.graph.status"]({});
    expect(status.enabled).toBe(true);
    expect((await c.scheduler.list()).filter(isDreamingAutomation)).toHaveLength(1);
  });

  it("answers the owner's turns only, never a designated person's", async () => {
    const c = await compose();
    load(c);
    enable(c);
    const lookup = c.loop.registry.get("people_lookup");
    const owner = await lookup?.run?.({ query: "Sam Lee" }, ctx("t1"));
    expect(owner?.isError).toBeUndefined();
    expect(String(owner?.output)).toContain("Sam Lee");
    const other = await lookup?.run?.(
      { query: "Sam Lee" },
      ctx("t1", { requester: { role: "designated", sessionKey: "telegram:peer:9" } as never }),
    );
    expect(other?.isError).toBe(true);
    expect(String(other?.output)).not.toContain("Acme");
  });

  it("indexes people and projects for Search, and drops them when forgotten", async () => {
    const c = await compose();
    const { entity } = await c.people.handlers["memory.entities.create"]({
      kind: "person",
      name: "Dana Whitfield",
      aliases: ["Dee"],
    });
    const index = new SqliteSearchIndex(c.db.sqlite, { now: () => Date.parse(WORLD.now) });
    await vi.waitFor(async () => {
      const { hits } = await index.query({ q: "Dee", filters: { kinds: ["person"] } });
      expect(hits.map((h) => h.id)).toEqual([`entity:${entity.id}`]);
    });
    await c.people.handlers["memory.entities.forget"]({ id: entity.id });
    await vi.waitFor(async () => {
      const { hits } = await index.query({ q: "Whitfield", filters: { kinds: ["person"] } });
      expect(hits).toHaveLength(0);
    });
  });

  it("applies the owner's edit of a card file to the graph", async () => {
    const c = await compose();
    load(c);
    const sam = byName(c, "Sam Lee");
    const path = (await c.people.cards.write(sam)) ?? "";
    expect(path).toMatch(/^people\/.+\.md$/);
    const file = (await c.memory.readFile(path))?.content ?? "";
    await c.memory.writeFileAsOwner(
      path,
      file.replace("## Facts\n", "## Facts\n- City: Oakland\n"),
    );
    await vi.waitFor(() => {
      expect(
        c.people.graph.facts(sam).map((f) => [f.attribute, f.value, f.provenance]),
      ).toContainEqual(["city", "Oakland", "owner"]);
    });
    // The agent still cannot write a card.
    await expect(
      c.memory.write(path, "x", { provenance: "agent", actor: "agent", source: "tool" }),
    ).rejects.toThrow();
  });

  it("runs the graph pass after dreaming, within the owner's budget", async () => {
    const c = await compose([
      [
        { type: "text_delta", text: '{"summary": "Works with you.", "facts": [], "loops": []}' },
        {
          type: "usage",
          usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
        },
        { type: "finish", reason: "stop" },
      ],
    ]);
    load(c);
    expect(await c.people.nightly()).toBeUndefined();
    enable(c, { enabled: true, model: { maxEntitiesPerNight: 1 } });
    const summary = await c.people.nightly();
    expect(summary).toMatch(/^people graph: 1 updated/);
    expect(summary).toContain("left for tomorrow");
    const status = await c.people.handlers["memory.graph.status"]({});
    expect(status.lastModelPassAt).toBe(new Date(WORLD.now).toISOString());
    expect(status.budget).toMatchObject({ entitiesUsed: 1, tokensUsed: 1000, maxEntities: 1 });
    // The dreaming automation's run reports dreaming and the graph pass together.
    const automation = (await c.scheduler.list()).find(isDreamingAutomation);
    const inner = { launch: vi.fn() };
    const run = await c.people
      .launcher(inner as never)
      .launch({
        automation,
        run: { id: "r" },
        threadId: "t",
        prompt: "",
        lightContext: true,
      } as never);
    const result = await run.result;
    expect(inner.launch).not.toHaveBeenCalled();
    expect(result.status).toBe("no_reply");
    expect(result.summary).toMatch(/^promoted \d+.*; people graph: /);
  });
});
