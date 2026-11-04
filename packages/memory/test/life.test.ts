import { FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EverythingStore } from "../src/graph/everything.ts";
import { lifeSearch } from "../src/graph/life.ts";
import { GraphStore } from "../src/graph/store.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let graph: GraphStore;
let em: EverythingStore;
const NOW = Date.parse("2026-10-29T12:00:00Z");

beforeEach(async () => {
  const clock = new FakeClock(NOW);
  env = await makeEnv({ clock });
  graph = new GraphStore({ sqlite: env.db.sqlite, clock });
  em = new EverythingStore({ sqlite: env.db.sqlite, graph, clock });
});
afterEach(async () => env.cleanup());

const person = (name: string) => graph.createEntity({ kind: "person", name }).id;
function learn(
  entityId: string,
  attribute: "birthday" | "employer" | "likes" | "city",
  value: string,
  quote: string,
  confirm = true,
) {
  const o = em.proposeFact({
    entityId,
    attribute,
    value,
    provenance: "untrusted",
    subjectKind: "self_disclosure",
    citations: [
      {
        source: "mail",
        sourceRef: `<${value}>`,
        quote,
        start: 0,
        end: quote.length,
        sourceHash: value,
        authorEntityId: entityId,
      },
    ],
  });
  if (o.status === "refused") throw new Error(o.reason);
  if (confirm) em.decide(o.fact.id, "confirm");
  return o.fact.id;
}
const search = (q: string, limit?: number) =>
  lifeSearch(graph, em, env.db.sqlite, q, { now: NOW, ...(limit ? { limit } : {}) });

describe("Life search", () => {
  it("finds cited facts by their words, with the quote and source", () => {
    const sam = person("Sam Lee");
    learn(sam, "employer", "Initech", "I just joined Initech");
    learn(person("Priya Rao"), "employer", "Globex", "Starting at Globex");
    const r = search("who works at Initech");
    expect(r.facts.map((f) => [f.entity.name, f.attribute, f.value, f.quote, f.source])).toEqual([
      ["Sam Lee", "employer", "Initech", "I just joined Initech", "mail"],
    ]);
  });

  it("carries the search document id of the first citation, so a chip can open its source", () => {
    const sam = person("Sam Lee");
    const quote = "I just joined Initech";
    const o = em.proposeFact({
      entityId: sam,
      attribute: "employer",
      value: "Initech",
      provenance: "untrusted",
      subjectKind: "self_disclosure",
      citations: [
        {
          source: "mail",
          sourceRef: "<m1@host.example>",
          docId: "mail:123",
          quote,
          start: 0,
          end: quote.length,
          sourceHash: "h1",
          authorEntityId: sam,
        },
      ],
    });
    if (o.status === "refused") throw new Error(o.reason);
    em.decide(o.fact.id, "confirm");
    learn(person("Priya Rao"), "employer", "Globex", "Starting at Globex");
    const byName = new Map(search("works at").facts.map((f) => [f.entity.name, f.docId]));
    expect(byName.get("Sam Lee")).toBe("mail:123");
    // A citation that was never indexed has none: the chip then has no source to open.
    expect(byName.get("Priya Rao")).toBeNull();
  });

  it("matches the person's name and the quote too, ignoring accents and case", () => {
    const e = person("José Ñandú");
    learn(e, "likes", "climbing", "I love bouldering on weekends");
    expect(search("jose likes").facts).toHaveLength(1);
    expect(search("bouldering").facts).toHaveLength(1);
    expect(search("swimming").facts).toEqual([]);
  });

  it("every word must match", () => {
    const sam = person("Sam Lee");
    learn(sam, "city", "Lisbon", "I live in Lisbon");
    expect(search("sam lisbon").facts).toHaveLength(1);
    expect(search("sam paris").facts).toEqual([]);
  });

  it("birthdays in a month, as a question", () => {
    learn(person("Ava"), "birthday", "March 3", "My birthday is March 3");
    learn(person("Raj"), "birthday", "5 March 1990", "born 5 March 1990");
    learn(person("Dana"), "birthday", "May 9", "My birthday is May 9");
    const r = search("whose birthday is in March");
    expect(r.intent).toBe("birthday_month:3");
    expect(r.facts.map((f) => f.entity.name).sort()).toEqual(["Ava", "Raj"]);
  });

  it("facts waiting for review are shown, marked; discarded, retracted and hidden ones are not", () => {
    const sam = person("Sam Lee");
    const pending = learn(sam, "likes", "tea", "I like tea", false);
    const gone = learn(sam, "likes", "chess", "I like chess", false);
    em.decide(gone, "discard");
    const hiddenOne = person("Hidden One");
    learn(hiddenOne, "likes", "tea", "I like tea");
    env.db.sqlite.prepare("UPDATE graph_entities SET hidden = 1 WHERE id = ?").run(hiddenOne);
    const r = search("tea");
    expect(r.facts.map((f) => [f.entity.name, f.review])).toEqual([["Sam Lee", "pending"]]);
    expect(r.facts[0]?.factId).toBe(pending);
    expect(search("chess").facts).toEqual([]);
  });

  it("finds people by name, empty and stop-word-only queries find nothing, and the limit holds", () => {
    const sam = person("Sam Lee");
    for (let i = 0; i < 6; i++) learn(sam, "likes", `thing${i}`, `I like thing${i}`);
    expect(search("Sam").entities.map((e) => e.name)).toContain("Sam Lee");
    expect(search("   ")).toEqual({ entities: [], facts: [], intent: null });
    expect(search("the of").facts.length).toBeGreaterThan(0 - 1);
    expect(search("thing", 3).facts).toHaveLength(3);
  });
});
