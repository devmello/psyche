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
  type SourcesConfig,
  sourceTag,
} from "@psyche/search";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { everythingSettings, indexedSources } from "../src/compose/everything.ts";
import {
  MEMORY_AGENT_NONE,
  MEMORY_NEEDS_ENCRYPTED_INDEX,
  memoryRecords,
  memorySettings,
  memorySourceDeps,
  sourceRules,
} from "../src/compose/search-memory.ts";

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
  // Learned from Mail and from Messages, accepted, plain: what a source's rules then decide.
  for (const [attribute, value, source] of [
    ["title", "Mail Title", "mail"],
    ["hometown", "Messages Town", "messages"],
  ] as const) {
    const learned = em.proposeFact({
      entityId: sam,
      attribute,
      value,
      provenance: "agent",
      subjectKind: "about_other",
      extractor: "test-model",
      citations: [{ ...cite(`<${attribute}>`), source }],
    });
    if (learned.status === "pending") em.decide(learned.fact.id, "confirm");
  }

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
  graph.setEdge({ src: sam, rel: "member_of", dst: trip, provenance: "owner" });
  const hush = graph.createEntity({ kind: "assignment", name: "Quiet task" }).id;
  graph.setEdge({ src: hush, rel: "part_of", dst: secret, provenance: "owner" });
  graph.createEntity({ kind: "event", name: "Maya's wedding", dueAt: "2026-12-05T17:00:00Z" });
  return { graph, em, db, sam, hidden, secret, trip };
}

/** The seam's settings with everything on its defaults (not encrypted, agent access accepted). */
const settings = (em: EverythingStore, config: SourcesConfig) => ({
  em,
  config: () => config,
  agentMode: () => "accepted" as const,
  memoryEncrypted: () => false,
});

/** Search's source choices as the owner would have them: Memory on, others as they ship. */
const searchConfig = (over: (c: SourcesConfig) => void = () => undefined): SourcesConfig => {
  const c = defaultSourcesConfig();
  c.sources.memory.enabled = true;
  over(c);
  return c;
};

describe("what the Memory source may index", () => {
  it("takes reviewed, non-sensitive, first-hand facts and nothing else", () => {
    const { graph, em, sam } = world();
    // The fixture's sensitive and third-party facts really are accepted: only the filter keeps
    // them out, and the waiting one is not current at all.
    const known = graph.facts(sam).map((f) => f.value);
    expect(known).toEqual(
      expect.arrayContaining(["Acme Robotics", "Sensitive Condition", "Untrusted Academy"]),
    );
    expect(known).not.toContain("Pending City");
    const records = memoryRecords(graph, em, sourceRules(searchConfig()));
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
    const { graph, em } = world();
    const records = memoryRecords(graph, em);
    expect(records.find((r) => r.name === "Submit visa form")?.partOf).toBe("Lisbon trip");
    expect(records.find((r) => r.name === "Quiet task")?.partOf).toBeNull();
  });

  it("carries a person's addresses so the never-index list applies", () => {
    const { graph, em } = world();
    expect(memoryRecords(graph, em).find((r) => r.name === "Sam Lee")?.identifiers).toEqual([
      "sam@example.com",
    ]);
  });

  it("indexes through the source, finds it, and drops it when it is hidden, retracted or off", async () => {
    const { graph, em, sam, secret } = world();
    const index = createSearchIndex();
    let on = true;
    const config = searchConfig();
    const indexer = new SourceIndexer(
      index,
      [
        memoryAdapter(
          memorySourceDeps({ graph: () => (on ? graph : undefined), ...settings(em, config) }),
        ),
      ],
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
    const { graph, em } = world();
    let ready = false;
    const deps = memorySourceDeps({
      graph: () => graph,
      ready: () => ready,
      ...settings(em, searchConfig()),
    });
    expect(deps.unavailable()).toBe("Memory is still opening");
    expect(deps.read()).toBeUndefined();
    ready = true;
    expect(deps.unavailable()).toBeUndefined();
    expect(deps.read()?.length).toBeGreaterThan(0);
  });
});

describe("the rules of the sources a fact was learned from", () => {
  const values = (recs: ReturnType<typeof memoryRecords>) =>
    recs.flatMap((r) => r.facts.map((f) => f.value));

  it("indexes learned facts as they are while Memory is owner-only with no summaries", () => {
    const { graph, em } = world();
    const v = values(memoryRecords(graph, em, sourceRules(searchConfig())));
    expect(v).toEqual(expect.arrayContaining(["Acme Robotics", "Mail Title", "Messages Town"]));
  });

  it("drops a fact learned from Messages once Memory is open to the agent (Messages is not)", () => {
    const { graph, em } = world();
    const cfg = searchConfig((c) => {
      c.sources.memory.agent = true;
    });
    expect(cfg.sources.messages.agent).toBe(false);
    const v = values(memoryRecords(graph, em, sourceRules(cfg)));
    expect(v).toContain("Mail Title");
    expect(v).not.toContain("Messages Town");
    // Written by the owner: no source rule applies.
    expect(v).toContain("Acme Robotics");
    // The owner allowed the agent at Messages: it comes back.
    cfg.sources.messages.agent = true;
    expect(values(memoryRecords(graph, em, sourceRules(cfg)))).toContain("Messages Town");
  });

  it("drops a fact whose source may not go to the model class Memory is set to", () => {
    const { graph, em } = world();
    // Memory's summaries go to a cloud model; Messages was kept off the cloud.
    const cloud = searchConfig((c) => {
      c.sources.memory.processing = "cloud";
      c.sources.messages.processing = "local";
    });
    let v = values(memoryRecords(graph, em, sourceRules(cloud)));
    expect(v).toContain("Mail Title");
    expect(v).not.toContain("Messages Town");
    // Memory kept on this Mac: a local-only source is fine.
    const local = searchConfig((c) => {
      c.sources.memory.processing = "local";
      c.sources.messages.processing = "local";
    });
    expect(values(memoryRecords(graph, em, sourceRules(local)))).toContain("Messages Town");
    // A source set to none reaches only Memory set to none.
    const none = searchConfig((c) => {
      c.sources.messages.processing = "none";
      c.sources.memory.processing = "local";
    });
    v = values(memoryRecords(graph, em, sourceRules(none)));
    expect(v).not.toContain("Messages Town");
  });

  it("treats a people-graph model-pass fact (agent, no citation) by the channel of its interactions", () => {
    const { graph, em } = world();
    const sam = graph.createEntity({ kind: "person", name: "Pat Quinn" }).id;
    const interaction = (source: string, ref: string) => {
      graph.upsertInteraction({
        kind: source === "mail" ? "mail" : "message",
        source,
        externalRef: ref,
        occurredAt: "2026-11-01T10:00:00Z",
        direction: "in",
        participants: [{ entityId: sam, role: "from" }],
      });
      return graph.interactionByRef(source, ref)?.id as string;
    };
    const fromMessages = interaction("messages", "m-1");
    const fromMail = interaction("mail", "e-1");
    // What `model-pass.ts` writes: provenance agent, the interaction ids as sources, no citation.
    graph.setFact({
      entityId: sam,
      attribute: "role",
      value: "Model Messages Fact",
      provenance: "agent",
      sources: [fromMessages],
    });
    graph.setFact({
      entityId: sam,
      attribute: "employer",
      value: "Model Mail Fact",
      provenance: "agent",
      sources: [fromMail],
    });
    graph.setFact({
      entityId: sam,
      attribute: "title",
      value: "Model Unfindable Fact",
      provenance: "agent",
      sources: ["lesson:gone"],
    });
    // Memory owner-only, no summaries: nothing narrows, except what cannot be traced.
    let v = values(memoryRecords(graph, em, sourceRules(searchConfig())));
    expect(v).toEqual(expect.arrayContaining(["Model Messages Fact", "Model Mail Fact"]));
    expect(v).not.toContain("Model Unfindable Fact");
    // Open to the agent: the one drawn from Messages (agent off) goes.
    v = values(
      memoryRecords(
        graph,
        em,
        sourceRules(
          searchConfig((c) => {
            c.sources.memory.agent = true;
          }),
        ),
      ),
    );
    expect(v).toContain("Model Mail Fact");
    expect(v).not.toContain("Model Messages Fact");
    // Summaries to a cloud model while Messages is kept off the cloud: it goes too.
    v = values(
      memoryRecords(
        graph,
        em,
        sourceRules(
          searchConfig((c) => {
            c.sources.memory.processing = "cloud";
            c.sources.messages.processing = "none";
          }),
        ),
      ),
    );
    expect(v).toContain("Model Mail Fact");
    expect(v).not.toContain("Model Messages Fact");
    // A fact the owner wrote is untouched by all of it.
    expect(v).toContain("Acme Robotics");
  });

  it("leaves out a learned fact whose citations cannot be checked", () => {
    const { graph, sam } = world();
    const noCitations = { citations: () => [] };
    const v = values(memoryRecords(graph, noCitations, sourceRules(searchConfig())));
    expect(v).toContain("Acme Robotics");
    expect(v).not.toContain("Mail Title");
    expect(graph.facts(sam).length).toBeGreaterThan(0);
  });

  it("ships Memory with no summaries (processing none) and the agent off", () => {
    const c = defaultSourcesConfig().sources.memory;
    expect(c).toMatchObject({ processing: "none", agent: false });
  });
});

describe("Memory and the agent, encryption", () => {
  it("cannot be opened to the agent while memory's agent access is none", () => {
    const { graph, em } = world();
    let mode: "none" | "accepted" = "none";
    const deps = memorySourceDeps({
      graph: () => graph,
      ...settings(em, searchConfig()),
      agentMode: () => mode,
    });
    expect(deps.agentBlocked?.()).toBe(MEMORY_AGENT_NONE);
    mode = "accepted";
    expect(deps.agentBlocked?.()).toBeUndefined();
  });

  it("cannot be switched on while memory is encrypted and the search index is not, and then reads nothing", () => {
    const { graph, em } = world();
    let memoryEncrypted = true;
    const deps = memorySourceDeps({
      graph: () => graph,
      ...settings(em, searchConfig()),
      memoryEncrypted: () => memoryEncrypted,
    });
    // The index has not said it is encrypted (not bound yet): it counts as plain.
    expect(deps.blocked?.()).toBe(MEMORY_NEEDS_ENCRYPTED_INDEX);
    expect(memoryAdapter(deps).unavailable()).toBe(MEMORY_NEEDS_ENCRYPTED_INDEX);
    expect(memoryAdapter(deps).cannotEnable?.()).toBe(MEMORY_NEEDS_ENCRYPTED_INDEX);
    // The switch being on is not enough: the index says it is plain (its key was unavailable).
    let indexEncrypted = false;
    deps.bindIndex?.(() => indexEncrypted);
    expect(deps.blocked?.()).toBe(MEMORY_NEEDS_ENCRYPTED_INDEX);
    // Only the index really being encrypted lets it through.
    indexEncrypted = true;
    expect(deps.blocked?.()).toBeUndefined();
    indexEncrypted = false;
    memoryEncrypted = false;
    expect(deps.blocked?.()).toBeUndefined();
  });

  it("reads its settings from the stored values", () => {
    const db = openDb(":memory:");
    const s = memorySettings(db);
    // Everything memory is off by default: the agent has no access.
    expect(s.agentMode()).toBe("none");
    expect(s.memoryEncrypted()).toBe(false);
    setSetting(db, "memory.everything", { enabled: true, agentAccess: "accepted" });
    setSetting(db, "memory.encrypt", true);
    expect(s.agentMode()).toBe("accepted");
    expect(s.memoryEncrypted()).toBe(true);
    setSetting(db, "memory.everything", { enabled: true, agentAccess: "none" });
    expect(s.agentMode()).toBe("none");
  });
});

describe("who a project, to-do or event is about", () => {
  it("carries the linked people, so a contact kept out of the index keeps out what is about them", async () => {
    const { graph, em } = world();
    const recs = memoryRecords(graph, em);
    const trip = recs.find((r) => r.name === "Lisbon trip");
    expect(trip?.related).toEqual(expect.arrayContaining(["Sam Lee", "Sammy", "sam@example.com"]));
    // A to-do's own links (to its project) are not people: nothing to exclude by.
    expect(recs.find((r) => r.name === "Submit visa form")?.related).toBeUndefined();

    const index = createSearchIndex();
    const config = searchConfig();
    const indexer = new SourceIndexer(
      index,
      [memoryAdapter(memorySourceDeps({ graph: () => graph, ...settings(em, config) }))],
      { config: () => config, now: () => NOW, pauseMs: 0 },
    );
    const titles = () =>
      (
        index.db
          .prepare("SELECT title FROM search_docs WHERE source = ? ORDER BY title")
          .all(sourceTag("memory")) as { title: string }[]
      ).map((d) => d.title);
    await indexer.tick();
    expect(titles()).toContain("Lisbon trip");
    // The owner keeps Sam out: Sam's own item and the project Sam belongs to go.
    config.exclude.contacts = ["sam@example.com"];
    await indexer.applyConfig();
    expect(titles()).not.toContain("Lisbon trip");
    expect(titles()).not.toContain("Sam Lee");
    expect(titles()).toContain("Submit visa form");
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
