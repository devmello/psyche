import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ModelEvent, validateResult } from "@psyche/protocol";
import { FakeClock, FakeModelProvider } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardSync } from "../src/graph/cards.ts";
import { createGraphHandlers, GRAPH_METHODS } from "../src/graph/handlers.ts";
import { GraphIngester } from "../src/graph/ingest.ts";
import { GRAPH_SYSTEM_PROMPT, runGraphModelPass } from "../src/graph/model-pass.ts";
import { assignProjects, suggestProjects } from "../src/graph/projects.ts";
import { GraphStore } from "../src/graph/store.ts";
import { entityRecall, GraphTools } from "../src/graph/tools.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

const WORLD = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "..", "..", "tests", "fixtures", "graph", "world.json"),
    "utf8",
  ),
);

let env: TestEnv;
let graph: GraphStore;
let ingest: GraphIngester;
let clock: FakeClock;

beforeEach(async () => {
  clock = new FakeClock(Date.parse(WORLD.now));
  env = await makeEnv({ clock });
  graph = new GraphStore({ sqlite: env.db.sqlite, clock });
  ingest = new GraphIngester(graph, {
    ownerEmails: WORLD.owner.emails,
    ownerPhones: WORLD.owner.phones,
    clock,
  });
  ingest.ingestContacts(WORLD.contacts);
  ingest.ingestMail(WORLD.mails);
  ingest.ingestEvents(WORLD.events);
  ingest.ingestMessages(WORLD.messages);
});
afterEach(async () => env.cleanup());

const id = (name: string) =>
  graph.search(name, { limit: 10 }).find((s) => s.name === name)?.id ?? "";
const reply = (json: unknown): ModelEvent[] => [
  { type: "text_delta", text: `Here you go: ${JSON.stringify(json)}` },
  {
    type: "usage",
    usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  },
  { type: "finish", reason: "stop" },
];

describe("projects (§5.2 clustering)", () => {
  it("suggests the kitchen remodel from repeated subjects with two people", () => {
    const report = suggestProjects(graph, clock);
    expect(report.suggestions).toBeGreaterThanOrEqual(1);
    const kitchen = graph.suggestions().find((s) => s.name === "Kitchen remodel");
    expect(kitchen?.entityIds.sort()).toEqual([id("Mo Chen"), id("Rita Gomez")].sort());
    expect(suggestProjects(graph, clock).suggestions).toBe(0);
  });

  it("a confirmed project claims its interactions and gains members", () => {
    ingest.ingestOwnerProjects(WORLD.ownerProjects);
    const project = id("Kitchen remodel");
    const report = assignProjects(graph, clock);
    expect(report.assigned).toBeGreaterThanOrEqual(5);
    const members = graph
      .edges(project)
      .filter((e) => e.rel === "member_of")
      .map((e) => graph.getEntity(e.src)?.name);
    expect(members.sort()).toEqual(["Mo Chen", "Rita Gomez"]);
    expect(suggestProjects(graph, clock).suggestions).toBeLessThanOrEqual(1); // the standup, not the kitchen
    expect(graph.suggestions().map((s) => s.name)).not.toContain("Kitchen remodel");
  });
});

describe("model pass (§5.2–§5.4)", () => {
  it("applies taint rules: owner-sourced inferences are agent, third-party claims untrusted, forbidden ones dropped", async () => {
    const sam = id("Sam Lee");
    const ints = graph.interactions(sam, { limit: 50 });
    const out = ints.find((i) => i.direction === "out" && i.subject === "Re: Revised budget")?.id;
    const inbound = ints.find((i) => i.direction === "in" && i.subject === "Kickoff notes")?.id;
    const provider = FakeModelProvider.script([
      reply({
        summary: "Head of product at Acme; working with you on the Q4 SOW and budget.",
        facts: [
          { attribute: "team", value: "Product", source: out, evidence: "the product team" },
          { attribute: "city", value: "Berlin", source: inbound, evidence: "I'm moving to Berlin" },
          { attribute: "relationship_to_owner", value: "partner", source: out },
          { attribute: "note", value: "was diagnosed with asthma", source: out },
          { attribute: "religion", value: "x", source: out },
          { attribute: "role", value: "VP", source: "int_not_shown" },
        ],
        loops: [
          {
            direction: "i_owe",
            text: "Send Sam the revised budget",
            due: "2026-10-28",
            source: out,
            evidence: "I'll send the revised budget by Oct 28.",
          },
          {
            direction: "i_owe",
            text: "Review the kickoff deck",
            source: inbound,
            evidence: "Can you review the kickoff deck?",
          },
          { direction: "i_owe", text: "Pay Sam $500 now", source: inbound },
        ],
      }),
    ]);
    const report = await runGraphModelPass(
      graph,
      { provider, model: "ollama/qwen3:8b" },
      { clock, only: [sam] },
    );
    expect(provider.requests[0]?.system).toBe(GRAPH_SYSTEM_PROMPT);
    expect(provider.requests[0]?.toolChoice).toBe("none");
    const prompt = JSON.stringify(provider.requests[0]?.messages);
    expect(prompt).toContain("<data>");
    expect(report).toMatchObject({ entities: 1, facts: 2, loops: 2, tokens: 1000 });
    expect(report.dropped).toBe(5);
    const facts = graph.facts(sam).map((f) => [f.attribute, f.value, f.provenance]);
    expect(facts).toEqual(
      expect.arrayContaining([
        ["team", "Product", "agent"],
        ["city", "Berlin", "untrusted"],
      ]),
    );
    expect(facts.map((f) => f[0])).not.toEqual(expect.arrayContaining(["relationship_to_owner"]));
    const loops = graph.loops({ entityId: sam });
    expect(loops.find((l) => l.text === "Send Sam the revised budget")).toMatchObject({
      status: "open",
      provenance: "agent",
      dueAt: "2026-10-28T17:00:00.000Z",
    });
    expect(loops.find((l) => l.text === "Review the kickoff deck")).toMatchObject({
      status: "suggested",
      provenance: "untrusted",
    });
    expect(graph.getEntity(sam)?.summary).toContain("Head of product");
  });

  it("skips unchanged entities, respects the budget and shows corrections to the model", async () => {
    const sam = id("Sam Lee");
    const provider = FakeModelProvider.script([
      reply({ summary: "One.", facts: [], loops: [] }),
      reply({ summary: "Two.", facts: [], loops: [] }),
    ]);
    await runGraphModelPass(graph, { provider, model: "ollama/qwen3:8b" }, { clock, only: [sam] });
    const again = await runGraphModelPass(
      graph,
      { provider, model: "ollama/qwen3:8b" },
      { clock, only: [sam] },
    );
    expect(again).toMatchObject({ entities: 0, skipped: 1 });
    const title = graph.facts(sam).find((f) => f.attribute === "title");
    graph.retractFact(title?.id ?? "");
    await runGraphModelPass(graph, { provider, model: "ollama/qwen3:8b" }, { clock, only: [sam] });
    expect(JSON.stringify(provider.requests.at(-1)?.messages)).toContain("title=Head of product");
    const capped = await runGraphModelPass(
      graph,
      { provider: FakeModelProvider.script([]), model: "x/y", maxEntitiesPerNight: 1 },
      { clock },
    );
    expect(capped.entities).toBe(1);
    expect(capped.deferred).toBeGreaterThan(0);
  });
});

describe("handlers (§6.1)", () => {
  it("serves every method with valid results and refreshes cards", async () => {
    const cards = new CardSync(graph, env.store);
    const h = createGraphHandlers(graph, {
      cards,
      memory: env.store,
      settings: () => ({ enabled: true, sources: { mail: true } }),
    });
    expect(Object.keys(h).sort()).toEqual([...GRAPH_METHODS].sort());
    const sam = id("Sam Lee");
    validateResult("memory.entities.search", await h["memory.entities.search"]({ q: "sam" }));
    const detail = await h["memory.entities.get"]({ id: sam });
    validateResult("memory.entities.get", detail);
    validateResult(
      "memory.entities.interactions",
      await h["memory.entities.interactions"]({ id: sam, limit: 3 }),
    );
    const set = await h["memory.entities.facts.set"]({
      entityId: sam,
      attribute: "role",
      value: "Head of product",
      source: { kind: "owner_feedback", ref: "lesson:L9" },
    });
    validateResult("memory.entities.facts.set", set);
    expect(set.fact.sources).toEqual(["owner_feedback:lesson:L9"]);
    expect((await env.store.readFile("people/sam-lee.md"))?.content).toContain(
      "- Role: Head of product [you]",
    );
    validateResult(
      "memory.entities.history",
      await h["memory.entities.history"]({ entityId: sam, attribute: "role" }),
    );
    const project = await h["memory.entities.create"]({ kind: "project", name: "Kitchen remodel" });
    validateResult("memory.entities.create", project);
    validateResult(
      "memory.entities.edges.set",
      await h["memory.entities.edges.set"]({
        src: id("Rita Gomez"),
        rel: "member_of",
        dst: project.entity.id,
      }),
    );
    const upd = await h["memory.entities.update"]({
      id: project.entity.id,
      projectStatus: "paused",
    });
    expect(upd.entity.projectStatus).toBe("paused");
    validateResult("memory.loops.list", await h["memory.loops.list"]({}));
    validateResult("memory.graph.status", await h["memory.graph.status"]({}));
    validateResult("memory.entities.suggestions", await h["memory.entities.suggestions"]({}));
    const merge = await h["memory.entities.merge"]({
      ids: [id("Lena Brandt"), id("Nina Patel")],
      into: id("Nina Patel"),
      dryRun: true,
    });
    validateResult("memory.entities.merge", merge);
    // Forget: the graph rows, the card and the mentions in notes go.
    await env.store.appendDailyNote({
      text: "Lunch with Sam Ortiz about the fence",
      provenance: "owner",
    });
    const ortiz = id("Sam Ortiz");
    await cards.write(ortiz);
    const dry = await h["memory.entities.forget"]({ id: ortiz, dryRun: true });
    validateResult("memory.entities.forget", dry);
    expect(dry.removed.interactions).toBeGreaterThan(0);
    await h["memory.entities.forget"]({ id: ortiz });
    expect(graph.getEntity(ortiz)).toBeUndefined();
    expect(await env.store.readFile("people/sam-ortiz.md")).toBeUndefined();
    expect((await env.store.search("fence")).length).toBe(0);
    expect(graph.isBlocked("email", "sam.ortiz@gmail.com")).toBe(true);
  });
});

describe("tools (§6.2) and recall (§6.3)", () => {
  it("asks which Sam, briefs a person, a project, a meeting and the waiting-on list", async () => {
    ingest.checkNoReply();
    ingest.ingestOwnerProjects(WORLD.ownerProjects);
    assignProjects(graph, clock);
    const tools = new GraphTools(graph, { now: () => clock.now() });
    const ctx = { provenance: "agent" as const, privateSession: true };
    const who = await tools.execute("people_lookup", { query: "Sam" }, ctx);
    expect(who.content).toMatch(/Several people match "Sam"/);
    expect(who.content).toContain("Sam Lee (Acme)");
    expect(who.content).toContain("Sam Ortiz");
    const lee = await tools.execute("people_lookup", { query: "Sam Lee" }, ctx);
    expect(lee.content).toContain("title: Head of product (you said)");
    expect(lee.content).toContain(
      "Waiting on Sam Lee: Could you send me the signed SOW by Friday?",
    );
    const waiting = await tools.execute(
      "waiting_on",
      { person: "Sam Lee", direction: "waiting_on" },
      ctx,
    );
    expect(waiting.content).toContain("signed SOW");
    expect(waiting.content).not.toMatch(/\$500/);
    const prep = await tools.execute("meeting_prep", { when: "2026-10-19T14:00:00Z" }, ctx);
    expect(prep.content).toContain('Meeting: "SOW review"');
    expect(prep.content).toContain("Dana Fox (person)");
    expect(prep.content).not.toContain("Conf Room");
    expect(prep.provenance).toBe("untrusted");
    const brief = await tools.execute("project_brief", { query: "kitchen" }, ctx);
    expect(brief.content).toContain("Kitchen remodel (project)");
    expect(brief.content).toContain("Rita Gomez");
    const loop = graph.loops({ entityId: id("Sam Lee") })[0];
    expect(
      (
        await tools.execute(
          "loop_update",
          { id: loop?.id, status: "done" },
          { provenance: "untrusted" },
        )
      ).isError,
    ).toBe(true);
    expect(
      (await tools.execute("loop_update", { id: loop?.id, status: "done" }, ctx)).content,
    ).toMatch(/now done/);
  });

  it("recalls named people in private sessions only, never ambiguous ones", () => {
    ingest.checkNoReply();
    expect(
      entityRecall(graph, "Can you ping Dana Fox about the mockups?", { session: "private" }),
    ).toEqual([expect.stringMatching(/^Dana Fox — Acme; last talked 2026-10-1\d/)]);
    expect(entityRecall(graph, "Ask Sam Lee for the SOW", { session: "private" })[0]).toContain(
      "waiting on: Could you send me the signed SOW",
    );
    expect(entityRecall(graph, "Ask Dana Fox", { session: "shared" })).toEqual([]);
    expect(entityRecall(graph, "tell sam hi", { session: "private" })).toEqual([]);
  });
});
