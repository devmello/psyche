import { FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExtractionSink,
  newWorkLaneLimits,
  readDue,
  validateWorkLane,
  type WorkLaneBatchItem,
} from "../src/extraction/index.ts";
import { hasHiddenChars } from "../src/graph/normalize.ts";
import { workLaneContext } from "../src/graph/work-learn.ts";
import { dateInQuote, parseDueInZone } from "../src/graph/zoned-date.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";
import {
  buildWorkWorld,
  WORK_NOW,
  WORK_ZONE,
  type WorkWorld,
  workItemsFor,
} from "./work-redteam-support.ts";

describe("due dates are read in the owner's zone", () => {
  it("offset-less means local, a bare date means 23:59 local, an explicit zone is honoured", () => {
    expect(parseDueInZone("2026-11-09", WORK_ZONE)).toBe("2026-11-10T07:59:00.000Z");
    expect(parseDueInZone("2026-11-09T09:00:00", WORK_ZONE)).toBe("2026-11-09T17:00:00.000Z");
    expect(parseDueInZone("2026-11-09T09:00:00Z", WORK_ZONE)).toBe("2026-11-09T09:00:00.000Z");
    expect(parseDueInZone("2026-11-09T09:00:00+01:00", WORK_ZONE)).toBe("2026-11-09T08:00:00.000Z");
    expect(parseDueInZone("2026-11-09", "UTC")).toBe("2026-11-09T23:59:00.000Z");
    // Daylight saving: a summer date in Los Angeles is UTC-7.
    expect(parseDueInZone("2026-07-09", WORK_ZONE)).toBe("2026-07-10T06:59:00.000Z");
    // A zone that does not exist falls back to UTC rather than throwing.
    expect(parseDueInZone("2026-11-09", "Not/AZone")).toBe("2026-11-09T23:59:00.000Z");
  });

  it("refuses impossible dates by round trip", () => {
    for (const bad of [
      "2026-02-31",
      "2026-13-01",
      "2026-04-31",
      "2026-11-09T25:00:00",
      "soon",
      "",
    ]) {
      expect(parseDueInZone(bad, "UTC"), bad).toBeNull();
      expect(readDue(bad, WORK_NOW, "UTC"), bad).toBeNull();
    }
    expect(parseDueInZone("2028-02-29", "UTC")).toBe("2028-02-29T23:59:00.000Z");
    expect(parseDueInZone("2027-02-29", "UTC")).toBeNull();
  });

  it("readDue also bounds the range", () => {
    expect(readDue("9999-12-31", WORK_NOW, WORK_ZONE)).toBeNull();
    expect(readDue("2019-01-01", WORK_NOW, WORK_ZONE)).toBeNull();
    expect(readDue("2026-11-09", WORK_NOW, WORK_ZONE)).toBe("2026-11-10T07:59:00.000Z");
  });

  it("dateInQuote reads absolute and relative expressions in the owner's day", () => {
    // Wednesday 2026-11-04, 10:00 in Los Angeles.
    const at = (q: string) => dateInQuote(q, WORK_NOW, WORK_ZONE);
    expect(at("due 2026-11-12")).toBe("2026-11-13T07:59:00.000Z");
    expect(at("due Nov 9")).toBe("2026-11-10T07:59:00.000Z");
    expect(at("due November 9th at 11:59pm")).toBe("2026-11-10T07:59:00.000Z");
    expect(at("due tomorrow")).toBe("2026-11-06T07:59:00.000Z");
    expect(at("due today")).toBe("2026-11-05T07:59:00.000Z");
    expect(at("due Friday")).toBe("2026-11-07T07:59:00.000Z");
    expect(at("due Wednesday")).toBe("2026-11-12T07:59:00.000Z");
    expect(at("due Friday at 5pm")).toBe("2026-11-07T01:00:00.000Z");
    expect(at("due soon")).toBeUndefined();
    expect(at("due Feb 31")).toBeUndefined();
  });
});

describe("hidden characters", () => {
  it("flags format, tag, variation and direction characters, not ordinary text", () => {
    const tags = String.fromCodePoint(0xe0069, 0xe0067);
    for (const bad of ["a​b", `Essay${tags}`, "a️b", "a؜b", "a᠎b", "a‮b", "a﻿b"]) {
      expect(hasHiddenChars(bad), JSON.stringify(bad)).toBe(true);
    }
    for (const ok of ["Lecture Work 7", "Résumé draft", "作业 3", "Café plan"]) {
      expect(hasHiddenChars(ok), ok).toBe(false);
    }
  });
});

describe("the work lane validator", () => {
  let env: TestEnv;
  let world: WorkWorld;
  beforeEach(async () => {
    const clock = new FakeClock(WORK_NOW);
    env = await makeEnv({ clock });
    world = buildWorkWorld(env.db.sqlite, clock);
  });
  afterEach(async () => env.cleanup());

  const item = (body: string, label = "Canvas"): WorkLaneBatchItem => {
    const [i] = workItemsFor({
      id: "unit",
      kind: "lane",
      description: "",
      body,
      subject: "Notice",
      sender: { label, key: "no-reply@instructure.com" },
      expect: {},
    });
    return i as WorkLaneBatchItem;
  };
  const claim = (over: object) => ({
    title: "Homework 1",
    parent_hint: null,
    due: null,
    kind: "new" as const,
    quote: "Homework 1 is due 2026-11-09.",
    start: 0,
    end: 0,
    ...over,
  });
  const run = (items: WorkLaneBatchItem[], assignments: ReturnType<typeof claim>[]) => {
    const ctx = workLaneContext(world.graph);
    return validateWorkLane({
      output: { items: [{ item: "i1", assignments, flags: { instruction_like: false } }] },
      items,
      parents: ctx.parents,
      targets: ctx.targets,
      sink: createExtractionSink(world.em),
      limits: newWorkLaneLimits(),
      now: WORK_NOW,
      timeZone: WORK_ZONE,
    });
  };

  it("Homework 1 does not bind to a notice about Homework 10 (token boundaries)", () => {
    const r = run(
      [item("Homework 10 is now due 2026-11-20.")],
      [claim({ quote: "Homework 10 is now due 2026-11-20." })],
    );
    expect(r.dropped).toEqual({ title_not_in_quote: 1 });
    expect(world.graph.suggestions(["pending"])).toEqual([]);
    const ok = run([item("Homework 1 is due 2026-11-09.")], [claim({})]);
    expect(ok.suggested).toBe(1);
  });

  it("two to-dos with one name: the parent hint decides, else nothing is guessed", () => {
    const a = world.graph.createEntity({ kind: "assignment", name: "Quiz 2" });
    const b = world.graph.createEntity({ kind: "assignment", name: "Quiz 2" });
    world.graph.setEdge({
      src: a.id,
      rel: "part_of",
      dst: world.ids.math as string,
      provenance: "owner",
    });
    world.graph.setEdge({
      src: b.id,
      rel: "part_of",
      dst: world.ids.chem as string,
      provenance: "owner",
    });
    const body = "Quiz 2 submission received.";
    const none = run([item(body)], [claim({ title: "Quiz 2", kind: "submitted", quote: body })]);
    expect(none.asks).toEqual([]);
    expect(none.dropped).toEqual({ submitted_ambiguous_item: 1 });
    const hinted = run(
      [item(body)],
      [claim({ title: "Quiz 2", kind: "submitted", quote: body, parent_hint: "CHEM 1B" })],
    );
    expect(hinted.asks.map((x) => x.entityId)).toEqual([b.id]);
  });

  it("the suggestion reason shows the sender's words as quoted data only when they are plain", () => {
    run(
      [item("New assignment: Essay 3, due 2026-11-09.")],
      [claim({ title: "Essay 3", quote: "New assignment: Essay 3, due 2026-11-09." })],
    );
    run(
      [item("New assignment: Essay 4, see grades.example.com or mail a@b.co")],
      [
        claim({
          title: "Essay 4",
          quote: "New assignment: Essay 4, see grades.example.com or mail a@b.co",
        }),
      ],
    );
    const reasons = world.graph.suggestions(["pending"]).map((s) => s.reason);
    expect(reasons).toEqual([
      'New from Canvas: "New assignment: Essay 3, due 2026-11-09."',
      "New from Canvas (quoted text withheld)",
    ]);
  });
});
