import type { GraphWorkStatus } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  dueGroup,
  fromDateInput,
  groupWork,
  isOverdue,
  isStale,
  isStaleFact,
  parseDay,
  parseQuickAdd,
  toDateInput,
} from "../src/memory-page/work.ts";

/** Work due groups, stale marks and the quick add line (docs/design/memory-everything-2026.md §3.6, §6.2). */

const DAY = 86_400_000;
// Sunday 2026-10-18, 10:12 UTC. The test setup pins UTC, so days here are UTC days.
const NOW = Date.parse("2026-10-18T10:12:00Z");
const at = (days: number, time = "23:59:00Z") =>
  `${new Date(NOW + days * DAY).toISOString().slice(0, 10)}T${time}`;

function row(
  workStatus: GraphWorkStatus | null,
  dueAt: string | null,
  signal: string | null = null,
) {
  return { id: "x", workStatus, dueAt, lastInteractionAt: signal };
}

describe("Work due groups", () => {
  it("puts an open item in past due, this week, later or no date by its due date", () => {
    expect(dueGroup(row("in_progress", at(-2)), NOW)).toBe("past_due");
    expect(dueGroup(row("not_started", at(0)), NOW)).toBe("this_week");
    expect(dueGroup(row("not_started", at(6)), NOW)).toBe("this_week");
    expect(dueGroup(row("not_started", at(7)), NOW)).toBe("later");
    expect(dueGroup(row("not_started", null), NOW)).toBe("no_date");
  });

  it("counts an item due earlier today as past due, and one due tonight as this week", () => {
    expect(dueGroup(row("not_started", "2026-10-18T09:00:00Z"), NOW)).toBe("past_due");
    expect(dueGroup(row("not_started", "2026-10-18T23:59:00Z"), NOW)).toBe("this_week");
  });

  it("keeps done and dropped items 14 days, and a handed-in item with a past date with Done", () => {
    expect(dueGroup(row("done", at(-3), at(-3)), NOW)).toBe("done");
    expect(dueGroup(row("dropped", at(-3), at(-3)), NOW)).toBe("done");
    expect(dueGroup(row("done", at(-20), at(-20)), NOW)).toBeNull();
    expect(dueGroup(row("submitted", at(-1)), NOW)).toBe("done");
    expect(dueGroup(row("submitted", at(2)), NOW)).toBe("this_week");
  });

  it("keeps an item the owner closed in this view, however old its date", () => {
    expect(dueGroup(row("done", at(-40), at(-40)), NOW, true)).toBe("done");
  });

  it("groups and orders a list: open by date, done newest first", () => {
    const rows = [
      { ...row("not_started", at(9)), id: "later" },
      { ...row("in_progress", at(-1)), id: "late" },
      { ...row("not_started", at(3)), id: "soon" },
      { ...row("not_started", at(1)), id: "sooner" },
      { ...row("done", at(-2), at(-2)), id: "d1" },
      { ...row("done", at(-5), at(-5)), id: "d2" },
      { ...row("done", at(-30), at(-30)), id: "gone" },
    ];
    const g = groupWork(rows, NOW);
    expect(g.past_due.map((r) => r.id)).toEqual(["late"]);
    expect(g.this_week.map((r) => r.id)).toEqual(["sooner", "soon"]);
    expect(g.later.map((r) => r.id)).toEqual(["later"]);
    expect(g.done.map((r) => r.id)).toEqual(["d1", "d2"]);
  });

  it("calls an open, unhanded item overdue once its date has passed", () => {
    expect(isOverdue(row("in_progress", at(-1)), NOW)).toBe(true);
    expect(isOverdue(row("submitted", at(-1)), NOW)).toBe(false);
    expect(isOverdue(row("done", at(-1)), NOW)).toBe(false);
    expect(isOverdue(row("not_started", at(1)), NOW)).toBe(false);
    expect(isOverdue(row("not_started", null), NOW)).toBe(false);
  });
});

describe("stale (§3.6)", () => {
  const assignment = (dueAt: string | null, lastSignalAt: string | null | undefined) => ({
    kind: "assignment" as const,
    workStatus: "in_progress" as const,
    dueAt,
    lastSignalAt,
  });

  it("is fresh with a signal in 3 days, or a due date a week away", () => {
    expect(isStale(assignment(at(2), at(-2, "10:00:00Z")), NOW)).toBe(false);
    expect(isStale(assignment(at(9), at(-30)), NOW)).toBe(false);
  });

  it("is stale with no recent signal and a date inside a week", () => {
    expect(isStale(assignment(at(2), at(-4)), NOW)).toBe(true);
    expect(isStale(assignment(at(2), null), NOW)).toBe(true);
    expect(isStale(assignment(null, at(-5)), NOW)).toBe(true);
    expect(isStale(assignment(at(-1), at(-5)), NOW)).toBe(true);
  });

  it("is never stale when nothing is known, or the work is finished or handed in", () => {
    expect(isStale(assignment(at(2), undefined), NOW)).toBe(false);
    for (const workStatus of ["done", "dropped", "submitted"] as const)
      expect(isStale({ ...assignment(at(2), at(-9)), workStatus }, NOW)).toBe(false);
  });

  it("gives a project 14 days, and leaves paused and done projects alone", () => {
    const project = (projectStatus: string, lastSignalAt: string | null) => ({
      kind: "project" as const,
      projectStatus,
      lastSignalAt,
    });
    expect(isStale(project("active", at(-13)), NOW)).toBe(false);
    expect(isStale(project("active", at(-15)), NOW)).toBe(true);
    expect(isStale(project("paused", at(-60)), NOW)).toBe(false);
    expect(isStale(project("done", at(-60)), NOW)).toBe(false);
  });

  it("says a next step or stopped-at older than 14 days may be out of date", () => {
    expect(isStaleFact(at(-13), NOW)).toBe(false);
    expect(isStaleFact(at(-15), NOW)).toBe(true);
  });
});

describe("the quick add line", () => {
  const courses = [
    { id: "c1", name: "CHEM 1B" },
    { id: "c2", name: "MATH 21", aliases: ["Linear Algebra"] },
  ];
  const parse = (text: string) => parseQuickAdd(text, courses, NOW, "UTC");

  it("reads a title, a course and a day", () => {
    const p = parse("Lab report, CHEM 1B, Fri");
    expect(p).toMatchObject({
      title: "Lab report",
      parent: { id: "c1", name: "CHEM 1B" },
      unmatched: null,
      dueAt: "2026-10-23T23:59:00.000Z",
    });
  });

  it("reads them in any order, and ignores case and spacing in the course", () => {
    expect(parse("Problem set, tomorrow, math  21")).toMatchObject({
      parent: { id: "c2" },
      dueAt: "2026-10-19T23:59:00.000Z",
    });
    expect(parse("Essay, linear algebra")).toMatchObject({ parent: { id: "c2" }, dueAt: null });
  });

  it("takes a title alone, a title with a day, and says what it could not match", () => {
    expect(parse("File taxes")).toMatchObject({ title: "File taxes", parent: null, dueAt: null });
    expect(parse("Pay rent, Nov 1")).toMatchObject({
      parent: null,
      unmatched: null,
      dueAt: "2026-11-01T23:59:00.000Z",
    });
    expect(parse("Poster, BIO 20, Mon")).toMatchObject({ parent: null, unmatched: "BIO 20" });
    expect(parse("   ")).toBeNull();
  });

  it("reads the usual ways to say a day", () => {
    const day = (s: string) => parseDay(s, NOW, "UTC");
    expect(day("today")).toEqual({ y: 2026, m: 10, d: 18 });
    expect(day("sun")).toEqual({ y: 2026, m: 10, d: 18 });
    expect(day("next sun")).toEqual({ y: 2026, m: 10, d: 25 });
    expect(day("Wed")).toEqual({ y: 2026, m: 10, d: 21 });
    expect(day("11/9")).toEqual({ y: 2026, m: 11, d: 9 });
    expect(day("9 Nov")).toEqual({ y: 2026, m: 11, d: 9 });
    expect(day("november 9th")).toEqual({ y: 2026, m: 11, d: 9 });
    expect(day("2026-12-01")).toEqual({ y: 2026, m: 12, d: 1 });
    expect(day("in 2 weeks")).toEqual({ y: 2026, m: 11, d: 1 });
    expect(day("Jan 5")).toEqual({ y: 2027, m: 1, d: 5 });
    expect(day("Feb 30")).toBeNull();
    expect(day("whenever")).toBeNull();
  });

  it("turns a date field into 11:59 pm that day and back", () => {
    expect(fromDateInput("2026-11-06", "UTC")).toBe("2026-11-06T23:59:00.000Z");
    expect(fromDateInput("2026-11-06", "America/Los_Angeles")).toBe("2026-11-07T07:59:00.000Z");
    expect(toDateInput("2026-11-07T07:59:00.000Z", "America/Los_Angeles")).toBe("2026-11-06");
    expect(fromDateInput("nope", "UTC")).toBeNull();
  });
});
