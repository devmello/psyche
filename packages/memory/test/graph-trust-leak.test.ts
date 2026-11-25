import { FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EverythingStore } from "../src/graph/everything.ts";
import { GraphStore } from "../src/graph/store.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let graph: GraphStore;
let em: EverythingStore;
let sam: string;

beforeEach(async () => {
  const clock = new FakeClock(Date.parse("2026-11-25T12:00:00Z"));
  env = await makeEnv({ clock });
  graph = new GraphStore({ sqlite: env.db.sqlite, clock });
  em = new EverythingStore({ sqlite: env.db.sqlite, graph, clock });
  sam = graph.createEntity({
    kind: "person",
    name: "Sam Lee",
    identifiers: [{ kind: "email", value: "sam@acme.com" }],
  }).id;
});
afterEach(async () => env.cleanup());

const set = (
  attribute: "city" | "employer" | "role",
  value: string,
  provenance: "owner" | "agent" | "untrusted" | "system",
  sources: string[] = [],
) => graph.setFact({ entityId: sam, attribute, value, provenance, sources });

const rows = (attribute: string) =>
  env.db.sqlite
    .prepare("SELECT value, provenance, review, superseded_by FROM graph_facts WHERE attribute = ?")
    .all(attribute) as {
    value: string;
    provenance: string;
    review: string;
    superseded_by: string | null;
  }[];

describe("setFact trust rules (memory wave 2A)", () => {
  it("an untrusted write is pending, even with a source id, and is not known", () => {
    const out = set("employer", "Initech", "untrusted", ["int_1"]);
    expect(out?.fact.review).toBe("pending");
    expect(graph.facts(sam)).toEqual([]);
    expect(em.reviewItems().items.map((i) => i.fact.value)).toEqual(["Initech"]);
  });

  it("no non-owner untrusted write is ever accepted", () => {
    set("employer", "A", "untrusted");
    set("city", "B", "untrusted", ["int_2"]);
    set("role", "C", "untrusted", ["int_3", "int_4"]);
    const all = env.db.sqlite
      .prepare("SELECT review FROM graph_facts WHERE provenance = 'untrusted'")
      .all() as { review: string }[];
    expect(all).toHaveLength(3);
    expect(all.every((r) => r.review === "pending")).toBe(true);
  });

  it("owner and system writes stay accepted", () => {
    expect(set("city", "SF", "owner")?.fact.review).toBe("accepted");
    expect(set("role", "Founder", "system")?.fact.review).toBe("accepted");
    expect(
      graph
        .facts(sam)
        .map((f) => f.value)
        .sort(),
    ).toEqual(["Founder", "SF"]);
  });

  it("a trusted agent write behaves as before: accepted, and supersedes an equal rank", () => {
    const a = set("employer", "Acme", "agent", ["int_1"]);
    const b = set("employer", "Initech", "agent", ["int_2"]);
    expect(a?.fact.review).toBe("accepted");
    expect(b?.fact.review).toBe("accepted");
    expect(b?.superseded).toBe(a?.fact.id);
    expect(graph.facts(sam).map((f) => f.value)).toEqual(["Initech"]);
  });

  it("owner city=SF then an untrusted NYC makes exactly one conflict row, no silent drop", () => {
    set("city", "SF", "owner");
    const first = set("city", "NYC", "untrusted", ["int_1"]);
    set("city", "NYC", "untrusted", ["int_2"]);
    set("city", "nyc", "untrusted");
    expect(first?.fact.review).toBe("pending");
    expect(first?.superseded).toBeNull();
    expect(graph.facts(sam).map((f) => f.value)).toEqual(["SF"]);
    const items = em.reviewItems().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ change: "conflict", previousValue: "SF" });
    expect(items[0]?.fact.sources).toEqual(["int_1", "int_2"]);
    expect(rows("city").filter((r) => r.value.toLowerCase() === "nyc")).toHaveLength(1);
  });

  it("an agent value against an owner fact is also one conflict row", () => {
    set("city", "SF", "owner");
    set("city", "NYC", "agent", ["int_1"]);
    set("city", "NYC", "agent", ["int_1"]);
    expect(graph.facts(sam).map((f) => f.value)).toEqual(["SF"]);
    expect(em.reviewItems().items).toHaveLength(1);
    expect(em.reviewItems().items[0]?.change).toBe("conflict");
  });

  it("untrusted never replaces an agent value, and confirming the conflict then does", () => {
    set("employer", "Acme", "agent", ["int_1"]);
    const out = set("employer", "Initech", "untrusted");
    expect(graph.facts(sam).map((f) => f.value)).toEqual(["Acme"]);
    expect(em.reviewItems().items[0]?.change).toBe("conflict");
    em.decide(out?.fact.id as string, "confirm");
    expect(graph.facts(sam).map((f) => f.value)).toEqual(["Initech"]);
  });

  it("three reworded untrusted next steps keep one pending row with the latest value", () => {
    const project = graph.createEntity({ kind: "project", name: "Offsite" }).id;
    for (const [i, v] of ["send the deck", "email the deck out", "get the deck sent"].entries())
      graph.setFact({
        entityId: project,
        attribute: "next_step",
        value: v,
        provenance: "untrusted",
        sources: [`int_${i}`],
      });
    const pending = env.db.sqlite
      .prepare(
        "SELECT value, sources FROM graph_facts WHERE attribute = 'next_step' AND review = 'pending'",
      )
      .all() as { value: string; sources: string }[];
    expect(pending).toHaveLength(1);
    expect(pending[0]?.value).toBe("get the deck sent");
    expect(JSON.parse(pending[0]?.sources ?? "[]")).toEqual(["int_2"]);
    expect(graph.facts(project)).toEqual([]);
  });

  it("a system value repeated by an agent is not a conflict (one ranking on both checks)", () => {
    const sys = set("city", "Berlin", "system");
    const again = set("city", "Berlin", "agent", ["int_9"]);
    expect(again?.fact.id).toBe(sys?.fact.id);
    expect(em.reviewItems().items).toHaveLength(0);
    expect(rows("city")).toHaveLength(1);
  });

  it("a lower-ranked repeat of an owner value only adds its source: no expiry, no provenance change", () => {
    const owner = set("city", "SF", "owner", ["owner_feedback"]);
    const q = "SELECT valid_to, provenance, evidence, updated_at FROM graph_facts WHERE id = ?";
    const before = env.db.sqlite.prepare(q).get(owner?.fact.id);
    expect(before).toMatchObject({ valid_to: null, provenance: "owner" });
    set("city", "SF", "untrusted", ["int_7"]);
    set("city", "SF", "agent", ["int_8"]);
    expect(env.db.sqlite.prepare(q).get(owner?.fact.id)).toEqual(before);
    const sources = env.db.sqlite
      .prepare("SELECT sources FROM graph_facts WHERE id = ?")
      .get(owner?.fact.id) as { sources: string };
    expect(JSON.parse(sources.sources)).toEqual(["owner_feedback", "int_7", "int_8"]);
    expect(rows("city")).toHaveLength(1);
  });

  it("the owner can still replace an agent or untrusted value", () => {
    set("employer", "Acme", "agent");
    const owner = set("employer", "Initech", "owner");
    expect(owner?.fact.review).toBe("accepted");
    expect(graph.facts(sam).map((f) => f.value)).toEqual(["Initech"]);
  });
});
