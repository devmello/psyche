import type { WorkflowEvent } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { anchorMatches } from "../src/index.ts";
import { setup } from "./helpers.ts";

/** Anchor matching for a Space's trackers (docs/design/spaces-2026.md section 6.3). */

const AT = "2026-11-20T09:00:00.000Z";
const ev = (e: Partial<WorkflowEvent> & Pick<WorkflowEvent, "source">): WorkflowEvent => ({
  id: "e1",
  at: AT,
  ...e,
});

describe("anchorMatches", () => {
  const anchors = [
    { kind: "mail_thread", ref: "thr-1" },
    { kind: "mail_thread", ref: "Work:thr-2" },
    { kind: "calendar", ref: "cal-1" },
    { kind: "calendar_series", ref: "series-1" },
    { kind: "folder", ref: "/Users/me/Kitchen" },
    { kind: "file", ref: "/Users/me/notes.txt" },
  ];

  const must: Array<[string, WorkflowEvent]> = [
    ["mail by thread id", ev({ source: "mail.received", threadId: "thr-1" })],
    ["mail by message id", ev({ source: "mail.received", messageId: "thr-1" })],
    [
      "mail by account-qualified thread id",
      ev({ source: "mail.received", account: "Work", threadId: "thr-2" }),
    ],
    ["calendar push with no ids (coarse)", ev({ source: "calendar.changed" })],
    ["calendar series", ev({ source: "calendar.changed", calendarEventId: "series-1" })],
    [
      "calendar by calendar id",
      { ...ev({ source: "calendar.changed" }), calendarId: "cal-1" } as WorkflowEvent,
    ],
    [
      "file in an anchored folder",
      ev({ source: "recording.added", path: "/Users/me/Kitchen/a.m4a" }),
    ],
    ["the anchored folder itself", ev({ source: "recording.added", path: "/Users/me/Kitchen" })],
    ["the anchored file", ev({ source: "recording.added", path: "/Users/me/notes.txt" })],
  ];
  const near: Array<[string, WorkflowEvent]> = [
    ["mail in another thread", ev({ source: "mail.received", threadId: "thr-9" })],
    [
      "mail whose subject names the thread",
      ev({ source: "mail.received", threadId: "thr-9", subject: "thr-1" }),
    ],
    [
      "mail with another account's prefix",
      ev({ source: "mail.received", account: "Home", threadId: "thr-2" }),
    ],
    ["mail with no ids", ev({ source: "mail.received", from: "thr-1" })],
    ["calendar series of another event", ev({ source: "calendar.changed", calendarEventId: "s2" })],
    [
      "another calendar",
      { ...ev({ source: "calendar.changed" }), calendarId: "cal-9" } as WorkflowEvent,
    ],
    [
      "a sibling folder sharing a prefix",
      ev({ source: "recording.added", path: "/Users/me/Kitchen-old/a.m4a" }),
    ],
    ["a file outside", ev({ source: "recording.added", path: "/Users/me/other.txt" })],
    ["followup.due", ev({ source: "followup.due" })],
  ];

  it.each(must)("matches: %s", (_name, event) => {
    expect(anchorMatches(event, anchors)).toBe(true);
  });
  it.each(near)("does not match: %s", (_name, event) => {
    expect(anchorMatches(event, anchors)).toBe(false);
  });

  it("matches nothing when the project anchors nothing of that kind", () => {
    expect(anchorMatches(ev({ source: "calendar.changed" }), [])).toBe(false);
    expect(anchorMatches(ev({ source: "mail.received", threadId: "thr-1" }), [])).toBe(false);
    expect(
      anchorMatches(ev({ source: "calendar.changed" }), [{ kind: "mail_thread", ref: "thr-1" }]),
    ).toBe(false);
  });
});

describe("scheduler.onWorkflowEvent", () => {
  it("taps every published event with no automation and starts no run", async () => {
    const { scheduler, launcher } = setup();
    const seen: string[] = [];
    const off = scheduler.onWorkflowEvent((e) => seen.push(e.id));
    expect(await scheduler.publishEvent(ev({ source: "mail.received", id: "m1" }))).toEqual([]);
    // A listener that throws never stops the event.
    scheduler.onWorkflowEvent(() => {
      throw new Error("boom");
    });
    await scheduler.publishEvent(ev({ source: "calendar.changed", id: "c1" }));
    off();
    await scheduler.publishEvent(ev({ source: "mail.received", id: "m2" }));
    await scheduler.flushEvents();
    expect(seen).toEqual(["m1", "c1"]);
    expect(launcher.requests).toHaveLength(0);
  });
});
