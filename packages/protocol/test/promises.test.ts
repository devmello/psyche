import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { Events, Methods } from "../src/index.ts";
import { ChatContextRef } from "../src/methods/chat.ts";
import {
  DailySectionId,
  GraphLoopStatus,
  NotificationKind,
  PromiseActAction,
  PromiseView,
} from "../src/schemas/index.ts";

/** The promise ledger's wire surface (docs/design/promise-ledger-2026.md §8.2). */
describe("promises protocol", () => {
  const spec = (name: string) =>
    (Methods as Record<string, { scope: string; sideEffecting: boolean; callsModel: boolean }>)[
      name
    ];

  it("declares the methods with the right scopes and idempotency", () => {
    const expected: Record<string, [string, boolean]> = {
      "promises.list": ["operator.read", false],
      "promises.get": ["operator.read", false],
      "promises.summary": ["operator.read", false],
      "promises.act": ["operator.write", true],
      "promises.add": ["operator.write", true],
      "promises.delete": ["operator.write", true],
      "promises.mute": ["operator.write", true],
    };
    for (const [name, [scope, side]] of Object.entries(expected)) {
      expect(spec(name), name).toBeDefined();
      expect({ name, scope: spec(name)?.scope, side: spec(name)?.sideEffecting }).toEqual({
        name,
        scope,
        side,
      });
      // Drafts go through chat; no ledger method calls a model.
      expect(spec(name)?.callsModel).toBe(false);
    }
  });

  it("registers the event and the added enum values", () => {
    expect(Object.keys(Events)).toContain("promise.updated");
    expect(Value.Check(GraphLoopStatus, "broken")).toBe(true);
    expect(Value.Check(GraphLoopStatus, "released")).toBe(true);
    expect(Value.Check(GraphLoopStatus, "lost")).toBe(false);
    expect(Value.Check(DailySectionId, "promises")).toBe(true);
    expect(Value.Check(NotificationKind, "promise_due")).toBe(true);
    expect(Value.Check(ChatContextRef, { kind: "promise", id: "p1", intent: "nudge" })).toBe(true);
    expect(Value.Check(ChatContextRef, { kind: "promise", id: "p1", intent: "spam" })).toBe(false);
  });

  it("checks actions and a scrubbed promise view", () => {
    for (const a of [
      { type: "confirm" },
      { type: "snooze", until: "2026-11-25T08:00:00.000Z" },
      { type: "set_due", dueAt: null },
      { type: "more_time", days: 3 },
      { type: "answer", answer: "not_yet" },
    ])
      expect(Value.Check(PromiseActAction, a), JSON.stringify(a)).toBe(true);
    for (const a of [
      { type: "more_time" },
      { type: "more_time", days: 0 },
      { type: "answer", answer: "maybe" },
      { type: "teleport" },
    ])
      expect(Value.Check(PromiseActAction, a), JSON.stringify(a)).toBe(false);

    const scrubbed = {
      id: "p1",
      direction: "i_owe",
      what: "send the deck",
      status: "open",
      state: "due_soon",
      basis: "promise",
      whatAction: "send",
      counterpartLabel: "Sam",
      dueAt: "2026-11-27T17:00:00.000Z",
      dueText: "by Friday",
      dueKind: "explicit",
      dueConfidence: 0.9,
      proposedDueAt: null,
      snoozedUntil: null,
      brokenAt: null,
      warnedAt: null,
      nudgeCount: 0,
      lastNudgeAt: null,
      sourceKind: "mail",
      provenance: "owner",
      confidence: 0.9,
      createdAt: "2026-11-24T10:00:00.000Z",
      closedAt: null,
      closedBy: null,
    };
    // No counterpartId, citations or events: the shape a remote caller gets.
    expect(Value.Check(PromiseView, scrubbed)).toBe(true);
    expect(Value.Check(PromiseView, { ...scrubbed, state: "lost" })).toBe(false);
  });
});
