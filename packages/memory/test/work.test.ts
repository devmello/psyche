import type { GraphWorkStatus } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  hoursUntilDue,
  isBlocked,
  isClosed,
  isFactStale,
  isOverdue,
  isStale,
  leavesWorkDue,
  nextWorkStatus,
  pastDuePhase,
  suggestProjectStatus,
  WORK_STATUSES,
  type WorkCause,
  type WorkSnapshot,
} from "../src/graph/work.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-04T12:00:00Z");
const iso = (offsetDays: number) => new Date(NOW + offsetDays * DAY).toISOString();

describe("nextWorkStatus (§3.4)", () => {
  // [from, cause, to, via]
  type Row = [GraphWorkStatus, WorkCause, GraphWorkStatus, "owner_stated" | "deterministic" | null];
  const rows: Row[] = [
    // the first owner or agent signal starts the work, once
    ["not_started", { type: "signal", provenance: "owner" }, "in_progress", "deterministic"],
    ["not_started", { type: "signal", provenance: "agent" }, "in_progress", "deterministic"],
    ["in_progress", { type: "signal", provenance: "owner" }, "in_progress", null],
    ["submitted", { type: "signal", provenance: "owner" }, "submitted", null],
    ["done", { type: "signal", provenance: "owner" }, "done", null],
    ["dropped", { type: "signal", provenance: "agent" }, "dropped", null],
    // the owner can set anything, and says so
    ["not_started", { type: "owner_set", to: "submitted" }, "submitted", "owner_stated"],
    ["in_progress", { type: "owner_set", to: "done" }, "done", "owner_stated"],
    ["in_progress", { type: "owner_set", to: "dropped" }, "dropped", "owner_stated"],
    ["done", { type: "owner_set", to: "in_progress" }, "in_progress", "owner_stated"],
    ["dropped", { type: "owner_set", to: "not_started" }, "not_started", "owner_stated"],
    ["done", { type: "owner_set", to: "done" }, "done", null],
    // a completed reminder in a tracked list is done; in any other list it is nothing
    ["not_started", { type: "reminder_completed", trustedList: true }, "done", "deterministic"],
    ["in_progress", { type: "reminder_completed", trustedList: true }, "done", "deterministic"],
    ["submitted", { type: "reminder_completed", trustedList: true }, "done", "deterministic"],
    ["done", { type: "reminder_completed", trustedList: true }, "done", null],
    ["dropped", { type: "reminder_completed", trustedList: true }, "dropped", null],
    ["in_progress", { type: "reminder_completed", trustedList: false }, "in_progress", null],
    // a done parent closes what is open, never what the owner dropped
    ["not_started", { type: "parent_done" }, "done", "deterministic"],
    ["in_progress", { type: "parent_done" }, "done", "deterministic"],
    ["submitted", { type: "parent_done" }, "done", "deterministic"],
    ["dropped", { type: "parent_done" }, "dropped", null],
    ["done", { type: "parent_done" }, "done", null],
  ];

  for (const [from, cause, to, via] of rows) {
    it(`${from} + ${cause.type}${"to" in cause ? ` ${cause.to}` : ""}${"trustedList" in cause ? ` (trusted ${cause.trustedList})` : ""} -> ${to}`, () => {
      const t = nextWorkStatus(from, cause);
      expect(t.status).toBe(to);
      expect(t.changed).toBe(via !== null);
      expect(t.via).toBe(via ?? undefined);
      expect(t.ask).toBeUndefined();
    });
  }

  it("never changes status because of untrusted text; it asks when the claim differs", () => {
    for (const from of WORK_STATUSES) {
      for (const claims of WORK_STATUSES) {
        const t = nextWorkStatus(from, { type: "untrusted_text", claims });
        expect(t.status).toBe(from);
        expect(t.changed).toBe(false);
        expect(t.ask).toEqual(claims === from ? undefined : { claims });
      }
    }
  });
});

describe("computed states (§3.4)", () => {
  const item = (over: Partial<WorkSnapshot> = {}): WorkSnapshot => ({
    kind: "assignment",
    workStatus: "in_progress",
    dueAt: iso(-1),
    lastSignalAt: null,
    ...over,
  });

  it("overdue: past due and not submitted, done or dropped", () => {
    expect(isOverdue(item({ workStatus: "not_started" }), NOW)).toBe(true);
    expect(isOverdue(item(), NOW)).toBe(true);
    for (const workStatus of ["submitted", "done", "dropped"] as const) {
      expect(isOverdue(item({ workStatus }), NOW)).toBe(false);
    }
    expect(isOverdue(item({ dueAt: iso(1) }), NOW)).toBe(false);
    expect(isOverdue(item({ dueAt: null }), NOW)).toBe(false);
    expect(isOverdue(item({ kind: "event", workStatus: null }), NOW)).toBe(false);
  });

  it("blocked: an open waiting-on loop or a current blocked_on fact", () => {
    expect(isBlocked({ openWaitingLoops: 1, blockedOn: null })).toBe(true);
    expect(isBlocked({ openWaitingLoops: 0, blockedOn: "the dataset" })).toBe(true);
    expect(isBlocked({ openWaitingLoops: 0, blockedOn: "  " })).toBe(false);
    expect(isBlocked({ openWaitingLoops: 0, blockedOn: null })).toBe(false);
  });

  it("closed: done or dropped assignments, done projects", () => {
    expect(isClosed({ kind: "assignment", workStatus: "done" })).toBe(true);
    expect(isClosed({ kind: "assignment", workStatus: "submitted" })).toBe(false);
    expect(isClosed({ kind: "project", workStatus: null, projectStatus: "done" })).toBe(true);
    expect(isClosed({ kind: "project", workStatus: null, projectStatus: "paused" })).toBe(false);
  });
});

describe("staleness (§3.6)", () => {
  const assignment = (
    dueDays: number | null,
    signalDaysAgo: number | null,
    workStatus: GraphWorkStatus = "in_progress",
  ): WorkSnapshot => ({
    kind: "assignment",
    workStatus,
    dueAt: dueDays === null ? null : iso(dueDays),
    lastSignalAt: signalDaysAgo === null ? null : iso(-signalDaysAgo),
  });

  it("an assignment is fresh with a signal in the last 3 days", () => {
    expect(isStale(assignment(2, 3), NOW)).toBe(false);
    expect(isStale(assignment(2, 0), NOW)).toBe(false);
    expect(isStale(assignment(2, 3.01), NOW)).toBe(true);
  });

  it("an assignment is fresh while the due date is 7 or more days away", () => {
    expect(isStale(assignment(7, 30), NOW)).toBe(false);
    expect(isStale(assignment(6.9, 30), NOW)).toBe(true);
    expect(isStale(assignment(40, null), NOW)).toBe(false);
  });

  it("no signal and no date is stale; an overdue assignment with no recent signal is stale", () => {
    expect(isStale(assignment(null, null), NOW)).toBe(true);
    expect(isStale(assignment(-2, 5), NOW)).toBe(true);
  });

  it("handed-in and closed assignments are never stale", () => {
    for (const s of ["submitted", "done", "dropped"] as const) {
      expect(isStale(assignment(1, 20, s), NOW)).toBe(false);
    }
  });

  it("a project is fresh with a signal in the last 14 days", () => {
    const project = (
      signalDaysAgo: number | null,
      projectStatus: "active" | "paused" | "done" = "active",
    ): WorkSnapshot => ({
      kind: "project",
      workStatus: null,
      projectStatus,
      dueAt: null,
      lastSignalAt: signalDaysAgo === null ? null : iso(-signalDaysAgo),
    });
    expect(isStale(project(14), NOW)).toBe(false);
    expect(isStale(project(14.5), NOW)).toBe(true);
    expect(isStale(project(null), NOW)).toBe(true);
    expect(isStale(project(60, "paused"), NOW)).toBe(false);
    expect(isStale(project(60, "done"), NOW)).toBe(false);
  });

  it("next_step and stopped_at older than 14 days may be out of date", () => {
    expect(isFactStale(iso(-14), NOW)).toBe(false);
    expect(isFactStale(iso(-14.1), NOW)).toBe(true);
    expect(isFactStale("not a date", NOW)).toBe(true);
  });
});

describe("project status suggestions (§3.4)", () => {
  const project = (over: Partial<Parameters<typeof suggestProjectStatus>[0]> = {}) => ({
    projectStatus: "active" as const,
    dueAt: null,
    lastSignalAt: iso(-1),
    createdAt: iso(-100),
    ...over,
  });
  it("suggests pausing after 30 quiet days, and done after the deadline plus 14", () => {
    expect(suggestProjectStatus(project(), NOW)).toBeNull();
    expect(suggestProjectStatus(project({ lastSignalAt: iso(-31) }), NOW)).toBe("paused");
    expect(suggestProjectStatus(project({ lastSignalAt: iso(-15), dueAt: iso(-3) }), NOW)).toBe(
      "done",
    );
    expect(
      suggestProjectStatus(project({ lastSignalAt: iso(-10), dueAt: iso(-3) }), NOW),
    ).toBeNull();
    expect(
      suggestProjectStatus(
        project({ lastSignalAt: iso(-60), projectStatus: "paused" as never }),
        NOW,
      ),
    ).toBeNull();
  });
});

describe("past due (§3.6)", () => {
  const due = (dueAt: string, workStatus: GraphWorkStatus = "in_progress"): WorkSnapshot => ({
    kind: "assignment",
    workStatus,
    dueAt,
    lastSignalAt: null,
  });
  it("asks the day after the due date, goes quiet after 14 days, and silence never changes status", () => {
    expect(pastDuePhase(due("2026-11-04T23:59:00Z"), NOW)).toBe("none"); // not yet due
    expect(pastDuePhase(due("2026-11-04T09:00:00Z"), NOW)).toBe("none"); // due today: ask tomorrow
    expect(pastDuePhase(due("2026-11-03T23:59:00Z"), NOW)).toBe("ask");
    expect(pastDuePhase(due("2026-10-21T12:00:00Z"), NOW)).toBe("ask");
    expect(pastDuePhase(due("2026-10-20T12:00:00Z"), NOW)).toBe("quiet");
    expect(pastDuePhase(due("2026-11-01T12:00:00Z", "submitted"), NOW)).toBe("none");
  });
  it("uses the owner's day", () => {
    // 11:59 pm Nov 3 in UTC-8 is Nov 4 07:59 UTC: the next local day began at 08:00 UTC.
    expect(pastDuePhase(due("2026-11-04T07:59:00Z"), NOW)).toBe("none");
    expect(pastDuePhase(due("2026-11-04T07:59:00Z"), NOW, -480)).toBe("ask");
    expect(pastDuePhase(due("2026-11-04T08:30:00Z"), NOW, -480)).toBe("none");
  });
  it("a done or dropped item leaves Work due 14 days after it closed", () => {
    const done = { kind: "assignment" as const, workStatus: "done" as const };
    expect(leavesWorkDue(done, iso(-13), NOW)).toBe(false);
    expect(leavesWorkDue(done, iso(-14), NOW)).toBe(true);
    expect(leavesWorkDue({ kind: "assignment", workStatus: "in_progress" }, iso(-30), NOW)).toBe(
      false,
    );
  });
  it("counts whole hours to the due date", () => {
    expect(hoursUntilDue(iso(1), NOW)).toBe(24);
    expect(hoursUntilDue(null, NOW)).toBeNull();
    expect(hoursUntilDue(iso(-1), NOW)).toBe(-24);
  });
});
