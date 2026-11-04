import { FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EverythingStore } from "../src/graph/everything.ts";
import { GraphStore } from "../src/graph/store.ts";
import { applyOwnerChatWork, type OwnerWorkClaim } from "../src/graph/work-learn.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * Undo for the work lines owner chat writes directly (MW7 follow-up): the prior value is the fact
 * the new one superseded; it comes back exactly, and only while the field has not changed since.
 */

const NOW = Date.parse("2026-11-04T18:00:00Z");
let env: TestEnv;
let graph: GraphStore;
let em: EverythingStore;
let thesis: string;

beforeEach(async () => {
  const clock = new FakeClock(NOW);
  env = await makeEnv({ clock });
  graph = new GraphStore({ sqlite: env.db.sqlite, clock });
  em = new EverythingStore({ sqlite: env.db.sqlite, graph, clock });
  thesis = graph.createEntity({
    kind: "assignment",
    name: "Thesis draft",
    dueAt: "2026-11-20T23:59:00Z",
  }).id;
});
afterEach(async () => env.cleanup());

const say = (text: string, claim: Partial<OwnerWorkClaim> & Pick<OwnerWorkClaim, "attribute">) =>
  applyOwnerChatWork(graph, {
    ownerText: text,
    threadId: "thr_1",
    parsed: {
      claims: [{ item: "Thesis draft", value: "", quote: text, ...claim }],
      assignments: [],
    },
    now: NOW,
    timeZone: "UTC",
    em,
  });

const current = (attribute: string) =>
  graph
    .facts(thesis)
    .filter((f) => f.attribute === attribute)
    .map((f) => f.value);

describe("undo of a direct chat update", () => {
  it("restores the previous value exactly, once", () => {
    graph.setFact({
      entityId: thesis,
      attribute: "stopped_at",
      value: "section 2",
      provenance: "owner",
    });
    const before = graph.facts(thesis).find((f) => f.attribute === "stopped_at");
    const r = say("Thesis draft: stopped at section 3", {
      attribute: "stopped_at",
      value: "section 3",
    });
    const applied = r.applied[0];
    expect(applied).toMatchObject({
      kind: "fact",
      attribute: "stopped_at",
      value: "section 3",
      previousValue: "section 2",
    });
    expect(current("stopped_at")).toEqual(["section 3"]);

    expect(em.undoChatWork(applied?.factId as string)).toBe("undone");
    expect(current("stopped_at")).toEqual(["section 2"]);
    // The same fact row is back, not a copy with a new date.
    expect(graph.facts(thesis).find((f) => f.attribute === "stopped_at")?.id).toBe(before?.id);

    expect(em.undoChatWork(applied?.factId as string)).toBe("already_undone");
    expect(current("stopped_at")).toEqual(["section 2"]);
  });

  it("with nothing before it, undo removes the line", () => {
    const r = say("Thesis draft: next I will write the intro", {
      attribute: "next_step",
      value: "write the intro",
      quote: "Thesis draft: next I will write the intro",
    });
    expect(r.applied[0]).toMatchObject({ kind: "fact", previousValue: null });
    expect(current("next_step")).toEqual(["write the intro"]);
    expect(em.undoChatWork(r.applied[0]?.factId as string)).toBe("undone");
    expect(current("next_step")).toEqual([]);
  });

  it("refuses, and touches nothing, once the field changed again", () => {
    graph.setFact({
      entityId: thesis,
      attribute: "stopped_at",
      value: "section 2",
      provenance: "owner",
    });
    const r = say("Thesis draft: stopped at section 3", {
      attribute: "stopped_at",
      value: "section 3",
    });
    // The owner (or a later message) moves it again.
    graph.setFact({
      entityId: thesis,
      attribute: "stopped_at",
      value: "section 5",
      provenance: "owner",
    });
    expect(em.undoChatWork(r.applied[0]?.factId as string)).toBe("changed_again");
    expect(current("stopped_at")).toEqual(["section 5"]);
  });

  it("progress keeps every line: a newer line blocks undoing an older one", () => {
    const a = say("Thesis draft: finished the outline", {
      attribute: "progress",
      value: "finished the outline",
      quote: "Thesis draft: finished the outline",
    });
    const b = say("I finished the intro of Thesis draft", {
      attribute: "progress",
      value: "finished the intro",
      quote: "I finished the intro of Thesis draft",
    });
    expect(em.undoChatWork(a.applied[0]?.factId as string)).toBe("changed_again");
    expect(current("progress")).toEqual(
      expect.arrayContaining(["finished the outline", "finished the intro"]),
    );
    expect(em.undoChatWork(b.applied[0]?.factId as string)).toBe("undone");
    expect(current("progress")).toEqual(["finished the outline"]);
  });

  it("a line the owner had already said is not undoable (nothing new was written)", () => {
    say("Thesis draft: stopped at section 3", { attribute: "stopped_at", value: "section 3" });
    const again = say("Thesis draft: stopped at section 3", {
      attribute: "stopped_at",
      value: "section 3",
    });
    expect(again.applied[0]).toMatchObject({ kind: "fact" });
    expect(again.applied[0]?.factId).toBeUndefined();
  });

  it("only works on chat-written work lines", () => {
    const f = graph.setFact({
      entityId: thesis,
      attribute: "stopped_at",
      value: "section 9",
      provenance: "owner",
    });
    expect(() => em.undoChatWork(f?.fact.id as string)).toThrow(/written from chat/);
    const d = graph.setFact({
      entityId: thesis,
      attribute: "note",
      value: "a note",
      provenance: "owner",
      source: { kind: "chat", ref: "thr_1" },
    });
    expect(() => em.undoChatWork(d?.fact.id as string)).toThrow(/written from chat/);
    expect(() => em.undoChatWork("fact_missing")).toThrow(/no such fact/);
  });
});

describe("a proposal carries the pending fact the owner decides", () => {
  it("names the pending fact, and nothing is applied until it is confirmed", () => {
    const r = say("Thesis draft is due Friday", {
      attribute: "deadline",
      value: "2026-11-06",
      quote: "Thesis draft is due Friday",
    });
    const p = r.applied[0];
    expect(p).toMatchObject({ kind: "proposed", attribute: "deadline" });
    expect(p?.factId).toBeDefined();
    expect(graph.getEntity(thesis)?.dueAt).toBe("2026-11-20T23:59:00.000Z");
    em.decide(p?.factId as string, "confirm");
    expect(graph.getEntity(thesis)?.dueAt).toBe("2026-11-06T23:59:00.000Z");
  });
});
