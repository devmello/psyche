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

  it("meetings about a project make a met_in edge only from two meetings", () => {
    const sam = person("Sam");
    const kit = thing("project", "Kitchen");
    interact("meeting", [sam.id], { subjects: [kit.id] });
    expect(map().edges).toEqual([]);
    interact("meeting", [sam.id], { subjects: [kit.id] });
    expect(kindBetween(map(), sam.id, kit.id)).toBe("met_in");
  });

  it("one meeting and one mail are shared interactions, not a met_in", () => {
    const sam = person("Sam");
    const kit = thing("project", "Kitchen");
    interact("meeting", [sam.id], { subjects: [kit.id] });
    interact("mail", [sam.id], { subjects: [kit.id] });
    expect(kindBetween(map(), sam.id, kit.id)).toBe("co_mentioned");
  });

  it("a mass mail is judged on everyone on it, so `kinds` cannot reveal links", () => {
    const people = Array.from({ length: 10 }, (_, i) => person(`P${i}`).id);
    const topics = Array.from({ length: 5 }, (_, i) => thing("topic", `T${i}`).id);
    interact("mail", people, { subjects: topics });
    interact("mail", people, { subjects: topics });
    expect(map().edges).toEqual([]);
    expect(map({ kinds: ["person"] }).edges).toEqual([]);
    expect(map({ kinds: ["topic"] }).edges).toEqual([]);
  });

  it("a long recipient list with a few known contacts links none of them", () => {
    const known = [person("A").id, person("B").id, person("C").id];
    // Twelve more people on the same mail: the whole list counts, not just the known three.
    const extra = Array.from({ length: 12 }, (_, i) => person(`X${i}`).id);
    interact("mail", [...known, ...extra]);
    interact("mail", [...known, ...extra]);
    expect(map({ kinds: ["person"] }).edges).toEqual([]);
  });

  it("only accepted, current edges count: pending, quarantined, discarded, expired and superseded do not", () => {
    const sam = person("Sam");
    const projects = [
      "accepted",
      "auto_accepted",
      "edited",
      "pending",
      "quarantined",
      "discarded",
    ].map((review) => ({ review, p: thing("project", `Project ${review}`) }));
    const insert = env.db.sqlite.prepare(
      `INSERT INTO graph_edges (id, src, dst, rel, provenance, confidence, sources, valid_from, valid_to, superseded_by, retracted_at, created_at, updated_at, review)
       VALUES (?, ?, ?, 'member_of', 'owner', 1, '[]', ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const { review, p } of projects)
      insert.run(
        `edge_${review}`,
        sam.id,
        p.id,
        iso(NOW - DAY),
        null,
        null,
        null,
        iso(NOW),
        iso(NOW),
        review,
      );
    const expired = thing("project", "Expired");
    insert.run(
      "edge_expired",
      sam.id,
      expired.id,
      iso(NOW - 9 * DAY),
      iso(NOW - DAY),
      null,
      null,
      iso(NOW),
      iso(NOW),
      "accepted",
    );
    const old = thing("project", "Superseded");
    insert.run(
      "edge_old",
      sam.id,
      old.id,
      iso(NOW - DAY),
      null,
      "edge_accepted",
      null,
      iso(NOW),
      iso(NOW),
      "accepted",
    );
    const m = map();
    const linked = m.edges.map((e) => (e.a === sam.id ? e.b : e.a)).sort();
    const want = projects
      .filter((x) => ["accepted", "auto_accepted", "edited"].includes(x.review))
      .map((x) => x.p.id)
      .sort();
    expect(linked).toEqual(want);
  });

  it("carries the private flag, like the list view", () => {
    const secret = person("Secret");
    const open = person("Open");
    env.db.sqlite.prepare("UPDATE graph_entities SET private = 1 WHERE id = ?").run(secret.id);
    const m = map();
    expect(m.nodes.find((n) => n.id === secret.id)?.private).toBe(true);
    expect(m.nodes.find((n) => n.id === open.id)?.private).toBeUndefined();
  });

  it("reuses a built map until the graph changes", () => {
    const sam = person("Sam");
    const first = map();
    expect(map()).toBe(first);
    expect(map({ limit: 10 })).not.toBe(first);
    person("Dana");
    const second = map();
    expect(second).not.toBe(first);
    expect(second.nodes.map((n) => n.id)).toContain(sam.id);
    expect(second.nodes).toHaveLength(2);
    interact("chat", [sam.id]);
    expect(map()).not.toBe(second);
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

  describe("the cache never serves a stale map (the clock is frozen throughout)", () => {
    it("doesn't keep a map built inside a transaction that rolls back", () => {
      const sam = person("Sam");
      graph.updateEntity(sam.id, { hidden: true });
      expect(map().nodes).toEqual([]);
      expect(() =>
        env.db.sqlite.transaction(() => {
          graph.updateEntity(sam.id, { hidden: false });
          expect(map().nodes.map((n) => n.id)).toEqual([sam.id]);
          throw new Error("roll back");
        })(),
      ).toThrow("roll back");
      expect(map().nodes).toEqual([]);
    });

    it("sees a retracted edge", () => {
      const sam = person("Sam");
      const kit = thing("project", "Kitchen");
      const e = graph.setEdge({ src: sam.id, rel: "member_of", dst: kit.id, provenance: "owner" });
      expect(map().edges).toHaveLength(1);
      graph.retractEdge(e?.edge.id ?? "");
      expect(map().edges).toEqual([]);
    });

    it("sees a rename", () => {
      const sam = person("Sam");
      expect(map().nodes[0]?.name).toBe("Sam");
      graph.updateEntity(sam.id, { name: "Samuel" });
      expect(map().nodes[0]?.name).toBe("Samuel");
    });

    it("sees a hide that comes with an unhide in the same instant", () => {
      const a = person("A");
      const b = person("B");
      const c = person("C");
      graph.updateEntity(c.id, { hidden: true });
      expect(
        map()
          .nodes.map((n) => n.id)
          .sort(),
      ).toEqual([a.id, b.id].sort());
      graph.updateEntity(c.id, { hidden: false });
      graph.updateEntity(a.id, { hidden: true });
      expect(
        map()
          .nodes.map((n) => n.id)
          .sort(),
      ).toEqual([b.id, c.id].sort());
    });

    it("sees the private flag change and an archived entity", () => {
      const a = thing("project", "A");
      const b = person("B");
      expect(map().nodes.find((n) => n.id === a.id)?.private).toBeUndefined();
      graph.updateEntity(a.id, { private: true });
      expect(map().nodes.find((n) => n.id === a.id)?.private).toBe(true);
      graph.updateEntity(b.id, { status: "archived" });
      expect(map().nodes.map((n) => n.id)).toEqual([a.id]);
    });

    it("sees an interaction whose participants were replaced by the same number of others", () => {
      const a = person("A");
      const b = person("B");
      const c = person("C");
      const put = (who: string[]) =>
        graph.upsertInteraction({
          kind: "chat",
          source: "test",
          externalRef: "same",
          occurredAt: iso(NOW - DAY),
          direction: "both",
          participants: who.map((entityId) => ({ entityId, role: "to" as const })),
        });
      put([a.id, b.id]);
      put([a.id, b.id]);
      graph.upsertInteraction({
        kind: "chat",
        source: "test",
        externalRef: "second",
        occurredAt: iso(NOW - DAY),
        direction: "both",
        participants: [a.id, b.id].map((entityId) => ({ entityId, role: "to" as const })),
      });
      expect(kindBetween(map(), a.id, b.id)).toBe("co_mentioned");
      // Same interaction, same size, different people.
      graph.upsertInteraction({
        kind: "chat",
        source: "test",
        externalRef: "second",
        occurredAt: iso(NOW - DAY),
        direction: "both",
        participants: [a.id, c.id].map((entityId) => ({ entityId, role: "to" as const })),
      });
      graph.upsertInteraction({
        kind: "chat",
        source: "test",
        externalRef: "same",
        occurredAt: iso(NOW - DAY),
        direction: "both",
        participants: [a.id, c.id].map((entityId) => ({ entityId, role: "to" as const })),
      });
      const m = map();
      expect(kindBetween(m, a.id, c.id)).toBe("co_mentioned");
      expect(kindBetween(m, a.id, b.id)).toBeUndefined();
    });

    it("sees an interaction that moved to another date and a loop that changed hands", () => {
      const a = person("A");
      const b = person("B");
      interact("chat", [a.id], { daysAgo: 1 });
      expect(map().nodes.find((n) => n.id === a.id)?.weight).toBeGreaterThan(0);
      const before = map();
      env.db.sqlite
        .prepare("UPDATE graph_interactions SET occurred_at = ?")
        .run(iso(NOW - 900 * DAY));
      expect(map()).not.toBe(before);
      graph.addLoop({
        direction: "waiting_on",
        text: "Reply",
        counterpartId: a.id,
        status: "open",
        provenance: "owner",
        detectedBy: "owner",
      });
      const withLoop = map();
      expect(withLoop.nodes.find((n) => n.id === a.id)?.weight).toBe(1);
      env.db.sqlite.prepare("UPDATE graph_loops SET counterpart_id = ?").run(b.id);
      const moved = map();
      expect(moved).not.toBe(withLoop);
      expect(moved.nodes.find((n) => n.id === b.id)?.weight).toBeGreaterThan(0);
    });
  });

  it("handles thousands of nodes and interactions within a time budget", () => {
    const N = 3000;
    const ent = env.db.sqlite.prepare(
      `INSERT INTO graph_entities (id, kind, name, sort_name, status, is_owner, pinned, hidden, project_type, private, title_untrusted, created_at, updated_at)
       VALUES (?, 'person', ?, ?, 'active', 0, 0, 0, 'project', 0, 0, ?, ?)`,
    );
    const inter = env.db.sqlite.prepare(
      `INSERT INTO graph_interactions (id, kind, source, external_ref, occurred_at, direction, created_at)
       VALUES (?, 'mail', 'test', ?, ?, 'in', ?)`,
    );
    const part = env.db.sqlite.prepare(
      "INSERT INTO graph_participants (interaction_id, entity_id, role) VALUES (?, ?, 'to')",
    );
    env.db.sqlite.transaction(() => {
      for (let i = 0; i < N; i++)
        ent.run(`ent_perf${i}`, `Person ${i}`, `person ${i}`, iso(NOW), iso(NOW));
      for (let i = 0; i < 30_000; i++) {
        inter.run(`int_perf${i}`, `x${i}`, iso(NOW - (i % 400) * DAY), iso(NOW));
        for (let k = 0; k < 4; k++) part.run(`int_perf${i}`, `ent_perf${(i * 7 + k * 131) % N}`);
      }
    })();
    const t0 = Date.now();
    const m = map({ limit: N });
    const built = Date.now() - t0;
    expect(m.nodes).toHaveLength(N);
    expect(m.edges.length).toBeGreaterThan(0);
    expect(built).toBeLessThan(2500);
    const t1 = Date.now();
    expect(map({ limit: N })).toBe(m);
    expect(Date.now() - t1).toBeLessThan(built / 3 + 50);
  });
});

describe("graphFingerprint", () => {
  it("gives no fingerprint for a closed store, so the map builds without the cache", async () => {
    const { openDb } = await import("@psyche/db");
    const { graphFingerprint } = await import("../src/graph/map.ts");
    const db = openDb(":memory:");
    expect(graphFingerprint(db.sqlite)).toMatch(/:\d+:\d+$/);
    db.close();
    expect(graphFingerprint(db.sqlite)).toBeUndefined();
  });
});
