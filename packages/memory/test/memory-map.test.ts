import { validateResult } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGraphHandlers } from "../src/graph/handlers.ts";
import { GraphStore } from "../src/graph/store.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/** The memory map builder (`memory.graph.map`): real relations only, capped, read-only. */

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

let env: TestEnv;
let graph: GraphStore;
let clock: FakeClock;
let seq = 0;

beforeEach(async () => {
  seq = 0;
  clock = new FakeClock(NOW);
  env = await makeEnv({ clock });
  graph = new GraphStore({ sqlite: env.db.sqlite, clock });
});
afterEach(async () => env.cleanup());

const person = (name: string) => graph.createEntity({ kind: "person", name });
const thing = (kind: "project" | "event" | "topic" | "org", name: string) =>
  graph.createEntity({ kind, name });

function interact(
  kind: "mail" | "meeting" | "chat",
  who: string[],
  over: { daysAgo?: number; subjects?: string[]; linkedBy?: "rule" | "model" } = {},
) {
  seq++;
  graph.upsertInteraction({
    kind,
    source: "test",
    externalRef: `x${seq}`,
    occurredAt: iso(NOW - (over.daysAgo ?? 1) * DAY),
    direction: "both",
    subject: `Subject ${seq}`,
    participants: who.map((entityId) => ({ entityId, role: "to" as const })),
    ...(over.subjects === undefined
      ? {}
      : {
          subjects: over.subjects.map((entityId) => ({
            entityId,
            linkedBy: over.linkedBy ?? ("rule" as const),
          })),
        }),
  });
}

const map = (opts: Parameters<GraphStore["memoryMap"]>[0] = {}) => graph.memoryMap(opts);
const kindBetween = (m: ReturnType<typeof map>, a: string, b: string) =>
  m.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))?.kind;

describe("memory map", () => {
  it("is empty for an empty store and validates against the protocol", () => {
    const m = map();
    expect(m).toEqual({ nodes: [], edges: [], total: 0, truncated: false });
    validateResult("memory.graph.map", m);
  });

  it("leaves out the owner, archived and hidden entities", () => {
    graph.ensureOwnerEntity({ name: "Me" });
    const sam = person("Sam");
    const gone = person("Gone");
    env.db.sqlite.prepare("UPDATE graph_entities SET status='archived' WHERE id = ?").run(gone.id);
    const secret = person("Secret");
    env.db.sqlite.prepare("UPDATE graph_entities SET hidden=1 WHERE id = ?").run(secret.id);
    expect(map().nodes.map((n) => n.id)).toEqual([sam.id]);
  });

  it("maps stored relations: member_of is works_on, attended is met_in, related_to is related", () => {
    const sam = person("Sam");
    const dana = person("Dana");
    const kit = thing("project", "Kitchen");
    const trip = thing("event", "Lisbon trip");
    graph.setEdge({ src: sam.id, rel: "member_of", dst: kit.id, provenance: "owner" });
    // `attended` is written by the life pass, not through setEdge.
    env.db.sqlite
      .prepare(
        `INSERT INTO graph_edges (id, src, dst, rel, provenance, confidence, sources, valid_from, created_at, updated_at, review)
         VALUES ('edge_att', ?, ?, 'attended', 'owner', 1, '[]', ?, ?, ?, 'accepted')`,
      )
      .run(sam.id, trip.id, iso(NOW), iso(NOW), iso(NOW));
    graph.setEdge({ src: sam.id, rel: "related_to", dst: dana.id, provenance: "owner" });
    const m = map();
    expect(kindBetween(m, sam.id, kit.id)).toBe("works_on");
    expect(kindBetween(m, sam.id, trip.id)).toBe("met_in");
    expect(kindBetween(m, sam.id, dana.id)).toBe("related");
    validateResult("memory.graph.map", m);
  });

  it("ignores retracted edges", () => {
    const sam = person("Sam");
    const kit = thing("project", "Kitchen");
    const e = graph.setEdge({ src: sam.id, rel: "member_of", dst: kit.id, provenance: "owner" });
    graph.retractEdge(e?.edge.id ?? "");
    expect(map().edges).toEqual([]);
  });

  it("co-mentioned needs two shared interactions; one is not a relation", () => {
    const sam = person("Sam");
    const dana = person("Dana");
    interact("mail", [sam.id, dana.id]);
    expect(map().edges).toEqual([]);
    interact("chat", [sam.id, dana.id]);
    const m = map();
    expect(kindBetween(m, sam.id, dana.id)).toBe("co_mentioned");
  });

  it("a mass mail links nobody", () => {
    const many = Array.from({ length: 15 }, (_, i) => person(`P${i}`).id);
    interact("mail", many);
    interact("mail", many);
    expect(map().edges).toEqual([]);
  });

  it("a meeting tied to a project is met_in, even once", () => {
    const sam = person("Sam");
    const kit = thing("project", "Kitchen");
    interact("meeting", [sam.id], { subjects: [kit.id] });
    expect(kindBetween(map(), sam.id, kit.id)).toBe("met_in");
  });

  it("a model-guessed subject link makes no edge", () => {
    const sam = person("Sam");
    const topic = thing("topic", "Climbing");
    interact("mail", [sam.id], { subjects: [topic.id], linkedBy: "model" });
    interact("mail", [sam.id], { subjects: [topic.id], linkedBy: "model" });
    expect(map().edges).toEqual([]);
  });

  it("the most specific kind wins when two relations join the same pair", () => {
    const sam = person("Sam");
    const kit = thing("project", "Kitchen");
    graph.setEdge({ src: sam.id, rel: "member_of", dst: kit.id, provenance: "owner" });
    interact("mail", [sam.id], { subjects: [kit.id] });
    interact("mail", [sam.id], { subjects: [kit.id] });
    const m = map();
    expect(m.edges).toHaveLength(1);
    expect(m.edges[0]?.kind).toBe("works_on");
  });

  it("sizes by importance: a recent, busy person outweighs a stale one", () => {
    const busy = person("Busy");
    const stale = person("Stale");
    for (let i = 0; i < 6; i++) interact("chat", [busy.id], { daysAgo: i });
    interact("chat", [stale.id], { daysAgo: 400 });
    const m = map();
    const w = (id: string) => m.nodes.find((n) => n.id === id)?.weight ?? -1;
    expect(m.nodes[0]?.id).toBe(busy.id);
    expect(w(busy.id)).toBe(1);
    expect(w(stale.id)).toBeLessThan(w(busy.id));
    expect(w(stale.id)).toBeGreaterThanOrEqual(0);
  });

  it("caps by importance and drops edges to the dropped nodes", () => {
    const a = person("A");
    const b = person("B");
    const c = person("C");
    for (let i = 0; i < 4; i++) interact("chat", [a.id, b.id], { daysAgo: i });
    interact("chat", [c.id], { daysAgo: 300 });
    const m = map({ limit: 2 });
    expect(m.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect(m.total).toBe(3);
    expect(m.truncated).toBe(true);
    expect(m.edges.every((e) => [a.id, b.id].includes(e.a) && [a.id, b.id].includes(e.b))).toBe(
      true,
    );
  });

  it("filters by kind", () => {
    person("Sam");
    const kit = thing("project", "Kitchen");
    expect(map({ kinds: ["project"] }).nodes.map((n) => n.id)).toEqual([kit.id]);
  });

  it("flags a person you used to talk to and have not heard from in a while", () => {
    const old = person("Old friend");
    const recent = person("Recent");
    const brief = person("Brief");
    for (const d of [90, 100, 120]) interact("chat", [old.id], { daysAgo: d });
    for (const d of [1, 2, 3]) interact("chat", [recent.id], { daysAgo: d });
    interact("chat", [brief.id], { daysAgo: 200 });
    env.db.sqlite
      .prepare("UPDATE graph_entities SET last_interaction_at = ? WHERE id = ?")
      .run(iso(NOW - 90 * DAY), old.id);
    const m = map();
    const quiet = (id: string) => m.nodes.find((n) => n.id === id)?.quiet;
    expect(quiet(old.id)).toBe(true);
    expect(quiet(recent.id)).toBeUndefined();
    expect(quiet(brief.id)).toBeUndefined();
  });

  it("carries only names and counts: no facts, notes or identifiers leak into a node", () => {
    const sam = graph.createEntity({
      kind: "person",
      name: "Sam",
      identifiers: [{ kind: "email", value: "sam@example.com" }],
    });
    graph.setFact({ entityId: sam.id, attribute: "city", value: "Lisbon", provenance: "owner" });
    const text = JSON.stringify(map());
    expect(text).not.toContain("sam@example.com");
    expect(text).not.toContain("Lisbon");
    expect(Object.keys(map().nodes[0] ?? {}).sort()).toEqual(
      ["id", "kind", "lastInteractionAt", "name", "pinned", "weight"].sort(),
    );
  });

  it("is served by the graph handlers and does not write", async () => {
    const sam = person("Sam");
    const before = env.db.sqlite.prepare("SELECT count(*) AS n FROM graph_entities").get();
    const h = createGraphHandlers(graph);
    const res = await h["memory.graph.map"]({});
    validateResult("memory.graph.map", res);
    expect(res.nodes.map((n) => n.id)).toEqual([sam.id]);
    expect(env.db.sqlite.prepare("SELECT count(*) AS n FROM graph_entities").get()).toEqual(before);
  });

  it("handles a few thousand nodes quickly", () => {
    const ids: string[] = [];
    const insert = env.db.sqlite.prepare(
      `INSERT INTO graph_entities (id, kind, name, sort_name, status, is_owner, pinned, hidden, project_type, private, title_untrusted, created_at, updated_at)
       VALUES (?, 'person', ?, ?, 'active', 0, 0, 0, 'project', 0, 0, ?, ?)`,
    );
    env.db.sqlite.transaction(() => {
      for (let i = 0; i < 3000; i++) {
        const id = `ent_perf${i}`;
        ids.push(id);
        insert.run(id, `Person ${i}`, `person ${i}`, iso(NOW), iso(NOW));
      }
    })();
    const t0 = Date.now();
    const m = map({ limit: 3000 });
    expect(m.nodes).toHaveLength(3000);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
