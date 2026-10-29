import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphCitationSource } from "@psyche/protocol";
import { FakeClock, FakeModelProvider } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyCardEdit, renderCard } from "../src/graph/cards.ts";
import { type CitationInput, EverythingStore } from "../src/graph/everything.ts";
import { GraphIngester } from "../src/graph/ingest.ts";
import { runGraphModelPass } from "../src/graph/model-pass.ts";
import { GraphStore } from "../src/graph/store.ts";
import {
  type AgentMemoryAccess,
  entityRecall,
  GraphTools,
  visibleToAgent,
} from "../src/graph/tools.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

const WORLD = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "..", "..", "..", "tests", "fixtures", "graph", "world.json"),
    "utf8",
  ),
);

let env: TestEnv;
let graph: GraphStore;
let em: EverythingStore;
let clock: FakeClock;
let mo: string;
let project: string;

const cite = (source: GraphCitationSource, ref: string, quote: string): CitationInput => ({
  source,
  sourceRef: ref,
  quote,
  start: 0,
  end: quote.length,
  sourceHash: ref,
});

function learn(
  entityId: string,
  attribute: "likes" | "city" | "note" | "status",
  value: string,
  sources: GraphCitationSource[],
  over: { sensitivity?: "health"; confirm?: boolean } = {},
) {
  const out = em.proposeFact({
    entityId,
    attribute,
    value,
    provenance: "agent",
    subjectKind: "owner_stated",
    sensitivity: over.sensitivity ?? "none",
    extractor: "fake/haiku",
    citations: sources.map((s, i) => cite(s, `<${value}-${i}>`, `the owner wrote ${value}`)),
  });
  if (out.status === "refused") throw new Error(out.reason);
  if (over.confirm !== false) em.decide(out.fact.id, "confirm");
  return out.fact.id;
}

const access = (over: Partial<AgentMemoryAccess> = {}): AgentMemoryAccess => ({
  mode: "accepted",
  seesSensitive: false,
  sourceAllowed: () => true,
  ...over,
});
const tools = (a: AgentMemoryAccess) =>
  new GraphTools(graph, { now: () => clock.now(), access: () => a, em });
const ctx = { threadId: "t", provenance: "trusted" } as never;
async function run(a: AgentMemoryAccess, name: string, input: unknown) {
  return (await tools(a).execute(name, input, ctx)) as { content: string; provenance: string };
}

beforeEach(async () => {
  clock = new FakeClock(Date.parse(WORLD.now));
  env = await makeEnv({ clock });
  graph = new GraphStore({ sqlite: env.db.sqlite, clock });
  em = new EverythingStore({ sqlite: env.db.sqlite, graph, clock });
  const ingest = new GraphIngester(graph, {
    ownerEmails: WORLD.owner.emails,
    ownerPhones: WORLD.owner.phones,
    clock,
  });
  ingest.ingestContacts(WORLD.contacts);
  ingest.ingestMail(WORLD.mails);
  ingest.ingestEvents(WORLD.events);
  ingest.ingestMessages(WORLD.messages);
  mo = graph.search("Mo Chen", { limit: 3 })[0]?.id ?? "";
  project = graph.createEntity({ kind: "project", name: "Garden Plan" }).id;
  learn(mo, "likes", "bouldering", ["notes"]);
  learn(mo, "city", "Reykjavik", ["messages"]);
  learn(mo, "note", "from mail and messages", ["mail", "messages"]);
  learn(mo, "likes", "asthmaticwords", ["notes"], { sensitivity: "health" });
  learn(mo, "note", "waiting review", ["mail"], { confirm: false });
  graph.setFact({ entityId: mo, attribute: "timezone", value: "Europe/Oslo", provenance: "owner" });
  learn(project, "status", "learned status", ["notes"]);
});
afterEach(async () => env.cleanup());

const LEARNED = [
  "bouldering",
  "Reykjavik",
  "from mail and messages",
  "asthmaticwords",
  "waiting review",
  "learned status",
];
const seen = (text: string) => LEARNED.filter((v) => text.includes(v));

describe("agentAccess × people_lookup / project_brief", () => {
  it("none: no learned fact reaches the agent, legacy facts still do", async () => {
    for (const [tool, input] of [
      ["people_lookup", { query: "Mo Chen" }],
      ["project_brief", { query: "Garden Plan" }],
    ] as const) {
      const r = await run(access({ mode: "none" }), tool, input);
      expect(seen(r.content), tool).toEqual([]);
    }
    expect(
      (await run(access({ mode: "none" }), "people_lookup", { query: "Mo Chen" })).content,
    ).toContain("Europe/Oslo");
  });

  it("accepted (the default): accepted non-sensitive facts only; pending and sensitive stay hidden", async () => {
    const r = await run(access(), "people_lookup", { query: "Mo Chen" });
    expect(seen(r.content).sort()).toEqual(
      ["Reykjavik", "bouldering", "from mail and messages"].sort(),
    );
    expect(r.content).not.toMatch(/unconfirmed/);
    expect(seen((await run(access(), "project_brief", { query: "Garden Plan" })).content)).toEqual([
      "learned status",
    ]);
  });

  it("all: pending facts appear, marked unconfirmed, and the result is untrusted", async () => {
    const r = await run(access({ mode: "all" }), "people_lookup", { query: "Mo Chen" });
    expect(r.content).toMatch(/note: waiting review \(unconfirmed, not yet reviewed\)/);
    expect(r.provenance).toBe("untrusted");
    expect(r.content).not.toContain("asthmaticwords");
  });

  it("sensitive facts need their own switch, even in all", async () => {
    expect(
      (await run(access({ mode: "all" }), "people_lookup", { query: "Mo Chen" })).content,
    ).not.toContain("asthmaticwords");
    expect(
      (
        await run(access({ mode: "accepted", seesSensitive: true }), "people_lookup", {
          query: "Mo Chen",
        })
      ).content,
    ).toContain("asthmaticwords");
    expect(
      (
        await run(access({ mode: "none", seesSensitive: true }), "people_lookup", {
          query: "Mo Chen",
        })
      ).content,
    ).not.toContain("asthmaticwords");
  });

  it("a fact is visible only if every citation's source may be searched by the agent", async () => {
    const noMessages = access({ sourceAllowed: (s) => s !== "messages" });
    const r = await run(noMessages, "people_lookup", { query: "Mo Chen" });
    expect(seen(r.content)).toEqual(["bouldering"]);
    const noNotes = access({ sourceAllowed: (s) => s !== "notes" });
    expect(
      seen((await run(noNotes, "people_lookup", { query: "Mo Chen" })).content).sort(),
    ).toEqual(["Reykjavik", "from mail and messages"].sort());
  });

  it("an unreadable citation set fails closed", () => {
    const fact = graph.facts(mo).find((f) => f.value === "bouldering");
    expect(fact).toBeDefined();
    expect(visibleToAgent(fact as never, access(), undefined)).toBe(false);
    expect(visibleToAgent(fact as never, access(), em)).toBe(true);
  });

  it("without an access function the default is accepted facts with sensitive hidden", async () => {
    const t = new GraphTools(graph, { now: () => clock.now(), em });
    const r = (await t.execute("people_lookup", { query: "Mo Chen" }, ctx)) as { content: string };
    expect(r.content).toContain("bouldering");
    expect(r.content).not.toContain("asthmaticwords");
    expect(r.content).not.toContain("waiting review");
  });
});

describe("the other read paths", () => {
  it("waiting_on and meeting_prep never carry a learned fact", async () => {
    for (const [tool, input] of [
      ["waiting_on", {}],
      ["meeting_prep", {}],
    ] as const) {
      expect(
        seen((await run(access({ mode: "all", seesSensitive: true }), tool, input)).content),
        tool,
      ).toEqual([]);
    }
  });

  it("entity recall shows no learned fact, and honours the visibility filter", () => {
    const text = "I should talk to Mo Chen about the plan";
    const lines = entityRecall(graph, text, {
      session: "private",
      visible: (f) => visibleToAgent(f, access({ mode: "none" }), em),
    });
    expect(seen(lines.join("\n"))).toEqual([]);
    expect(seen(entityRecall(graph, text, { session: "private" }).join("\n"))).toEqual([]);
  });

  it("search finds no one by a sensitive learned fact", () => {
    expect(graph.search("asthmaticwords", { limit: 5 })).toEqual([]);
    expect(graph.search("bouldering", { limit: 5 }).map((e) => e.id)).toContain(mo);
  });

  it("person cards leave learned facts out of the file unless allowed, and an edit never retracts them", () => {
    const plain = renderCard(graph, mo)?.content ?? "";
    expect(seen(plain)).toEqual([]);
    expect(plain).toContain("Europe/Oslo");
    expect(seen(renderCard(graph, mo, { learnedFacts: true })?.content ?? "")).toContain(
      "bouldering",
    );
    const entity = graph.getEntity(mo);
    if (entity === undefined) throw new Error("no entity");
    applyCardEdit(graph, entity, plain);
    expect(graph.facts(mo).map((f) => f.value)).toContain("bouldering");
    expect(graph.facts(mo).find((f) => f.value === "bouldering")?.retractedAt).toBeNull();
  });

  it("the summary pass never sends learned facts to the model", async () => {
    const provider = new FakeModelProvider({ id: "fake" });
    provider.enqueue([
      {
        type: "text_delta",
        text: '{"summary":"x","facts":[],"loops":[],"status":null,"next_step":null}',
      },
      { type: "finish", reason: "stop" },
    ]);
    await runGraphModelPass(graph, { provider, model: "fake/m" }, { clock, only: [mo] });
    const sent = provider.requests
      .flatMap((r) =>
        r.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))),
      )
      .join("\n");
    expect(provider.requests.length).toBeGreaterThan(0);
    expect(seen(sent)).toEqual([]);
    expect(sent).toContain("Europe/Oslo");
  });
});
