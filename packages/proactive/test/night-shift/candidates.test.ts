import { describe, expect, it } from "vitest";
import {
  type CandidateSource,
  calendarOverlapCandidates,
  fileCandidates,
  followupCandidates,
  followupsSource,
  gatherCandidates,
  quietThreadCandidates,
} from "../../src/index.ts";

const NOW = Date.parse("2026-11-25T01:00:00Z");
const DAY = 86_400_000;

describe("deterministic candidates", () => {
  it("quiet threads become tainted mail candidates, at most 8; one with no id is dropped", () => {
    const base = {
      source: "gmail",
      subject: "S",
      who: "Ann",
      kind: "no_reply" as const,
      daysQuiet: 4,
    };
    const items = Array.from({ length: 12 }, (_, i) => ({ ...base, threadId: `t${i}` }));
    const out = quietThreadCandidates([base, ...items]);
    expect(out).toHaveLength(8);
    expect(out[0]?.key).toBe("t0");
    expect(out[0]?.taintSources).toEqual([{ sourceKind: "email", origin: "gmail" }]);
    expect(out.every((c) => c.domain === "mail")).toBe(true);
  });

  it("follow-ups: only commitments due by tomorrow; a later provider plugs in unchanged", async () => {
    const f = [
      { id: "a", text: "Send the deck", dueAt: new Date(NOW - DAY).toISOString() },
      { id: "b", text: "Far off", dueAt: new Date(NOW + 9 * DAY).toISOString() },
      { id: "c", text: "No date" },
    ];
    expect(followupCandidates(f, NOW).map((c) => c.key)).toEqual(["c", "a"]);
    // The promise ledger's provider replaces `daily.followups` through the same source.
    const promises = followupsSource(() => [
      { id: "p1", text: "Promised", dueAt: new Date(NOW).toISOString() },
    ]);
    const g = await gatherCandidates([promises], new Set(["reminders"]), NOW);
    expect(g.candidates.map((c) => c.id)).toEqual(["reminders:p1"]);
  });

  it("calendar: overlaps and duplicates of solo events in the next 3 days only", () => {
    const ev = (
      id: string,
      title: string,
      start: string,
      end: string,
      attendees: string[] = [],
    ) => ({
      id,
      title,
      start,
      end,
      attendees,
    });
    const out = calendarOverlapCandidates(
      [
        ev("1", "Focus", "2026-11-25T09:00:00Z", "2026-11-25T10:00:00Z"),
        ev("2", "Focus", "2026-11-25T09:00:00Z", "2026-11-25T10:00:00Z"),
        ev("3", "Gym", "2026-11-25T09:30:00Z", "2026-11-25T10:30:00Z"),
        ev("4", "Review", "2026-11-25T09:30:00Z", "2026-11-25T10:30:00Z", ["ann@x.com"]),
        ev("5", "Far", "2026-12-20T09:00:00Z", "2026-12-20T10:00:00Z"),
        ev("6", "Far", "2026-12-20T09:00:00Z", "2026-12-20T10:00:00Z"),
      ],
      NOW,
    );
    expect(out.map((c) => c.id)).toEqual(["calendar:1:2", "calendar:1:3", "calendar:2:3"]);
    expect(out[0]?.facts.situation).toBe("duplicate");
    // An event with another attendee is never a candidate.
    expect(out.some((c) => c.id.includes(":4"))).toBe(false);
  });

  it("files: older than a day, top level of the granted folder only, at most 10", () => {
    const f = (name: string, age: number, folder = "/Users/o/Downloads") => ({
      path: `${folder}/${name}`,
      folder,
      name,
      size: 10,
      mtimeMs: NOW - age,
    });
    const out = fileCandidates(
      [
        f("old.pdf", 3 * DAY),
        f("new.pdf", DAY / 2),
        { ...f("deep.pdf", 3 * DAY), path: "/Users/o/Downloads/x/deep.pdf" },
      ],
      NOW,
    );
    expect(out.map((c) => c.key)).toEqual(["/Users/o/Downloads/old.pdf"]);
    const many = Array.from({ length: 15 }, (_, i) => f(`f${i}.pdf`, (2 + i) * DAY));
    expect(fileCandidates(many, NOW)).toHaveLength(10);
  });

  it("a failing source contributes nothing and does not fail the night; off domains are skipped", async () => {
    const boom: CandidateSource = {
      name: "mail",
      domain: "mail",
      max: 5,
      list: () => {
        throw new Error("x");
      },
    };
    const ok = followupsSource(() => [{ id: "a", text: "t", dueAt: new Date(NOW).toISOString() }]);
    const g = await gatherCandidates([boom, ok], new Set(["mail", "reminders"]), NOW);
    expect(g.failed).toEqual(["mail"]);
    expect(g.candidates).toHaveLength(1);
    const off = await gatherCandidates([ok], new Set(["mail"]), NOW);
    expect(off.candidates).toHaveLength(0);
  });
});
