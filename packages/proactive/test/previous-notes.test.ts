import type { MeetingNotes } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { FeedStore, lastMeetingNotes } from "../src/index.ts";
import { testDb } from "./helpers.ts";

/** Prep reads the last meeting notes for the same series (§4.5 step 3); #842 item 7. */

function notes(id: string, title: string, decision: string): MeetingNotes {
  return {
    id,
    meetingId: null,
    title,
    startedAt: "2026-10-20T16:00:00.000Z",
    durationMs: 1_800_000,
    recordingItemId: null,
    transcriptItemId: null,
    summary: [],
    decisions: [{ text: decision }],
    actionItems: [],
    openQuestions: [],
    model: { role: "utility", remote: false },
    provenance: "untrusted",
  } as unknown as MeetingNotes;
}

function post(id: string, createdAt: string, n: MeetingNotes) {
  return {
    id,
    title: `Notes: ${n.title}`,
    bodyMd: "",
    citations: [],
    cluster: null,
    score: 1,
    reasons: [],
    exploration: false,
    briefingId: null,
    feedback: null,
    createdAt,
    batchId: id,
    kind: "meeting_notes" as const,
    card: { type: "meeting_notes" as const, notes: n },
  };
}

describe("previous meeting notes for prep", () => {
  it("returns the newest notes for the same series, ignoring case and spacing", () => {
    const clock = new FakeClock(Date.parse("2026-10-26T08:00:00Z"));
    const db = testDb(clock);
    const feed = new FeedStore(db.sqlite);
    feed.insert(
      post("p_old", "2026-10-06T16:00:00.000Z", notes("n_old", "Weekly sync", "Ship v1")) as never,
    );
    feed.insert(
      post("p_new", "2026-10-13T16:00:00.000Z", notes("n_new", "Weekly sync", "Ship v2")) as never,
    );
    feed.insert(
      post(
        "p_other",
        "2026-10-20T16:00:00.000Z",
        notes("n_other", "Design review", "Pick a font"),
      ) as never,
    );
    const found = lastMeetingNotes(db.sqlite, "  weekly   SYNC ");
    expect(found?.id).toBe("n_new");
    expect(found?.decisions[0]?.text).toBe("Ship v2");
  });

  it("is undefined when no earlier notes share the title", () => {
    const clock = new FakeClock(Date.parse("2026-10-26T08:00:00Z"));
    const db = testDb(clock);
    const feed = new FeedStore(db.sqlite);
    feed.insert(
      post("p_other", "2026-10-20T16:00:00.000Z", notes("n_other", "Design review", "x")) as never,
    );
    expect(lastMeetingNotes(db.sqlite, "Weekly sync")).toBeUndefined();
  });
});
