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

  it("the owner can still replace an agent or untrusted value", () => {
    set("employer", "Acme", "agent");
    const owner = set("employer", "Initech", "owner");
    expect(owner?.fact.review).toBe("accepted");
    expect(graph.facts(sam).map((f) => f.value)).toEqual(["Initech"]);
  });
});
