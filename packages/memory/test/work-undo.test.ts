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

  it("only works on ids a chat note offered", () => {
    const f = graph.setFact({
      entityId: thesis,
      attribute: "stopped_at",
      value: "section 9",
      provenance: "owner",
      source: { kind: "chat", ref: "thr_1" },
    });
    expect(() => em.undoChatWork(f?.fact.id as string)).toThrow(/not offered/);
    expect(() => em.undoChatWork("fact_missing")).toThrow(/not offered/);
    expect(current("stopped_at")).toEqual(["section 9"]);
  });

  it("deletes the undone line and its quote, and a second undo says so", () => {
    const r = say("Thesis draft: stopped at section 3", {
      attribute: "stopped_at",
      value: "section 3",
    });
    const id = r.applied[0]?.factId as string;
    em.undoChatWork(id);
    expect(
      env.db.sqlite.prepare("SELECT count(*) AS n FROM graph_facts WHERE id = ?").get(id),
    ).toEqual({
      n: 0,
    });
    expect(em.undoChatWork(id)).toBe("already_undone");
  });

  it("refuses after the seven-day window", () => {
    const r = say("Thesis draft: stopped at section 3", {
      attribute: "stopped_at",
      value: "section 3",
    });
    env.db.sqlite
      .prepare("UPDATE memory_work_undo SET created_at = '2026-10-01T00:00:00.000Z'")
      .run();
    expect(() => em.undoChatWork(r.applied[0]?.factId as string)).toThrow(/window/);
  });

  it("puts back a to-do the write started and its last signal, only if unchanged since", () => {
    const entity = () => graph.getEntity(thesis);
    expect(entity()?.workStatus).toBe("not_started");
    const signalBefore = entity()?.lastSignalAt ?? null;
    const r = say("Thesis draft: stopped at section 3", {
      attribute: "stopped_at",
      value: "section 3",
    });
    expect(entity()?.workStatus).toBe("in_progress");
    expect(em.undoChatWork(r.applied[0]?.factId as string)).toBe("undone");
    expect(entity()?.workStatus).toBe("not_started");
    expect(entity()?.lastSignalAt ?? null).toBe(signalBefore);
    expect(
      graph.facts(thesis).some((f) => f.attribute === "status" && f.value === "in_progress"),
    ).toBe(false);

    // The owner moves the item on after the chat line: Undo removes the line, not their status.
    const r2 = say("Thesis draft: stopped at section 4", {
      attribute: "stopped_at",
      value: "section 4",
    });
    graph.setWorkStatus(thesis, { type: "owner_set", to: "submitted" });
    expect(em.undoChatWork(r2.applied[0]?.factId as string)).toBe("undone");
    expect(entity()?.workStatus).toBe("submitted");
  });

  it("a revived inference expires again", () => {
    // Only a project can hold an agent's next step (a to-do's work lines are the owner's).
    const capstone = graph.createEntity({ kind: "project", name: "Capstone" }).id;
    graph.setFact({
      entityId: capstone,
      attribute: "next_step",
      value: "outline",
      provenance: "agent",
    });
    const text = "Capstone: next I will write the intro";
    const r = applyOwnerChatWork(graph, {
      ownerText: text,
      threadId: "thr_1",
      parsed: {
        claims: [
          { item: "Capstone", attribute: "next_step", value: "write the intro", quote: text },
        ],
        assignments: [],
      },
      now: NOW,
      timeZone: "UTC",
      em,
    });
    expect(em.undoChatWork(r.applied[0]?.factId as string)).toBe("undone");
    const agent = env.db.sqlite
      .prepare(
        "SELECT valid_to, superseded_by FROM graph_facts WHERE entity_id = ? AND provenance = 'agent' AND attribute = 'next_step'",
      )
      .get(capstone) as { valid_to: string | null; superseded_by: string | null };
    expect(agent.superseded_by).toBeNull();
    expect(agent.valid_to).not.toBeNull();
  });

  it("when the owner marked the chat line wrong in Memory, undo still revives the prior", () => {
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
    graph.retractFact(r.applied[0]?.factId as string);
    expect(current("stopped_at")).toEqual([]);
    expect(em.undoChatWork(r.applied[0]?.factId as string)).toBe("undone");
    expect(current("stopped_at")).toEqual(["section 2"]);
  });

  it("when nothing was replaced and the owner removed it, it says removed", () => {
    const r = say("Thesis draft: stopped at section 3", {
      attribute: "stopped_at",
      value: "section 3",
    });
    graph.retractFact(r.applied[0]?.factId as string);
    expect(em.undoChatWork(r.applied[0]?.factId as string)).toBe("removed");
  });
});

describe("a work item's history", () => {
  it("lists the changes newest first and marks only chat updates in the window undoable", () => {
    graph.setFact({
      entityId: thesis,
      attribute: "next_step",
      value: "email Rao",
      provenance: "owner",
    });
    const r = say("Thesis draft: stopped at section 3", {
      attribute: "stopped_at",
      value: "section 3",
    });
    const history = em.workHistory(thesis);
    expect(history.map((h) => [h.attribute, h.value, h.origin, h.undoable])).toEqual(
      expect.arrayContaining([
        ["stopped_at", "section 3", "chat", true],
        ["next_step", "email Rao", "you", false],
      ]),
    );
    expect(history.find((h) => h.factId === r.applied[0]?.factId)?.undoable).toBe(true);
  });

  it("is no longer undoable once undone, changed again, or past seven days", () => {
    const r = say("Thesis draft: stopped at section 3", {
      attribute: "stopped_at",
      value: "section 3",
    });
    const id = r.applied[0]?.factId as string;
    graph.setFact({
      entityId: thesis,
      attribute: "stopped_at",
      value: "section 5",
      provenance: "owner",
    });
    // Changed again: still listed and still inside the window; Undo itself answers changed_again.
    expect(em.workHistory(thesis).find((h) => h.factId === id)?.undoable).toBe(true);
    expect(em.undoChatWork(id)).toBe("changed_again");
    const later = new GraphStore({
      sqlite: env.db.sqlite,
      clock: new FakeClock(NOW + 8 * 86_400_000),
    });
    const store = new EverythingStore({
      sqlite: env.db.sqlite,
      graph: later,
      clock: new FakeClock(NOW + 8 * 86_400_000),
    });
    expect(store.workHistory(thesis).find((h) => h.factId === id)?.undoable).toBe(false);
  });

  it("words a cited line from its source and keeps the chip", () => {
    const out = em.proposeFact({
      entityId: thesis,
      attribute: "next_step",
      value: "submit the form",
      provenance: "untrusted",
      subjectKind: "about_other",
      sensitivity: "none",
      confidence: 0.8,
      extractor: "model/x",
      citations: [
        {
          source: "mail",
          sourceRef: "<a@b>",
          quote: "please submit the form",
          start: 0,
          end: 22,
          sourceHash: "h",
          authorEntityId: null,
        },
      ],
    });
    if (out.status === "refused") throw new Error(out.reason);
    em.decide(out.fact.id, "confirm");
    const h = em.workHistory(thesis).find((x) => x.factId === out.fact.id);
    expect(h).toMatchObject({ origin: "mail", undoable: false, chip: { source: "mail" } });
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
