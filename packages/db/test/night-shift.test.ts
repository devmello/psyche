import { describe, expect, it } from "vitest";
import {
  getNight,
  getNightByDate,
  getStagedAction,
  insertNight,
  insertStagedAction,
  listNights,
  listStagedActions,
  updateNight,
  updateStagedAction,
} from "../src/index.ts";
import { memoryDb } from "./helpers.ts";

const base = (nightId: string, over: Record<string, unknown> = {}) => ({
  nightId,
  seq: 0,
  domain: "mail" as const,
  targetKey: "thread:1",
  tool: "mail_reply_draft",
  kind: "send_email",
  sideEffect: "write",
  paramsHash: "sha256:p",
  bindingHash: "sha256:b",
  summary: "Reply to Sam",
  ...over,
});

describe("night shift repo (real SQLite)", () => {
  it("writes then reads every night column", () => {
    const db = memoryDb();
    const n = insertNight(db, {
      night: "2026-11-24",
      status: "running",
      candidates: [{ domain: "mail", id: "t1" }],
      startedAt: "2026-11-24T01:00:00.000Z",
    });
    expect(getNight(db, n.id)).toEqual(n);
    const done = updateNight(db, n.id, {
      status: "done",
      stopReason: "budget",
      spentUsd: 0.42,
      tokens: 1234,
      reviewStatus: "ready",
      expiresAt: "2026-11-27T01:00:00.000Z",
      finishedAt: "2026-11-24T02:00:00.000Z",
    });
    expect(done).toMatchObject({
      status: "done",
      stopReason: "budget",
      spentUsd: 0.42,
      tokens: 1234,
      reviewStatus: "ready",
      expiresAt: "2026-11-27T01:00:00.000Z",
      finishedAt: "2026-11-24T02:00:00.000Z",
      candidates: [{ domain: "mail", id: "t1" }],
    });
    expect(getNightByDate(db, "2026-11-24")).toEqual(done);
    expect(listNights(db, "ready")).toHaveLength(1);
    expect(listNights(db, "applied")).toHaveLength(0);
  });

  it("refuses a second row for the same night and a bad status", () => {
    const db = memoryDb();
    insertNight(db, { night: "2026-11-24", status: "empty" });
    expect(() => insertNight(db, { night: "2026-11-24", status: "empty" })).toThrow();
    expect(() => insertNight(db, { night: "2026-11-25", status: "bogus" as never })).toThrow();
  });

  it("writes then reads every staged action column", () => {
    const db = memoryDb();
    const n = insertNight(db, { night: "2026-11-24", status: "running" });
    const a = insertStagedAction(
      db,
      base(n.id, {
        target: { thread: "1" },
        params: { to: ["a@x.test"], body: "hi" },
        preview: { body: "hi" },
        why: "Sam asked a question",
        precondition: { newestMessageId: "m9", count: 4 },
        inverse: null,
        send: { recipients: ["a@x.test"], contentHash: "sha256:c" },
        taint: true,
        taintSources: [{ sourceKind: "mail" }],
        taskId: "task1",
        toolCallId: "call1",
      }),
    );
    expect(getStagedAction(db, a.id)).toEqual(a);
    expect(a).toMatchObject({
      status: "ready",
      taint: true,
      taintSources: [{ sourceKind: "mail" }],
      target: { thread: "1" },
      params: { to: ["a@x.test"], body: "hi" },
      preview: { body: "hi" },
      why: "Sam asked a question",
      precondition: { newestMessageId: "m9", count: 4 },
      send: { recipients: ["a@x.test"], contentHash: "sha256:c" },
      inverse: null,
      result: null,
      approvalId: null,
      appliedAt: null,
      taskId: "task1",
      toolCallId: "call1",
    });
    const applied = updateStagedAction(db, a.id, {
      status: "applied",
      result: { receiptId: "r1", refs: ["draft:1"] },
      approvalId: "ap1",
      appliedAt: "2026-11-24T08:00:00.000Z",
    });
    expect(applied).toMatchObject({
      status: "applied",
      result: { receiptId: "r1", refs: ["draft:1"] },
      approvalId: "ap1",
      appliedAt: "2026-11-24T08:00:00.000Z",
    });
    expect(getStagedAction(db, a.id)).toEqual(applied);
  });

  it("supersedes the earlier live item on the same target and keeps other targets", () => {
    const db = memoryDb();
    const n = insertNight(db, { night: "2026-11-24", status: "running" });
    const first = insertStagedAction(db, base(n.id, { domain: "calendar", targetKey: "event:1" }));
    const other = insertStagedAction(
      db,
      base(n.id, { seq: 1, domain: "calendar", targetKey: "event:2" }),
    );
    const second = insertStagedAction(
      db,
      base(n.id, { seq: 2, domain: "calendar", targetKey: "event:1" }),
    );
    const by = Object.fromEntries(listStagedActions(db, n.id).map((i) => [i.id, i.status]));
    expect(by).toEqual({ [first.id]: "superseded", [other.id]: "ready", [second.id]: "ready" });
  });

  it("the unique index refuses two live items for one target", () => {
    const db = memoryDb();
    const n = insertNight(db, { night: "2026-11-24", status: "running" });
    insertStagedAction(db, base(n.id));
    const b = insertStagedAction(db, base(n.id, { seq: 1, targetKey: "thread:2" }));
    expect(() =>
      db.sqlite.prepare("UPDATE staged_actions SET target_key = 'thread:1' WHERE id = ?").run(b.id),
    ).toThrow(/UNIQUE/);
  });

  it("expiry clears params and preview but keeps the row", () => {
    const db = memoryDb();
    const n = insertNight(db, { night: "2026-11-24", status: "done" });
    const a = insertStagedAction(db, base(n.id, { params: { body: "secret" }, preview: { b: 1 } }));
    const e = updateStagedAction(db, a.id, { status: "expired", clearParams: true });
    expect(e).toMatchObject({ status: "expired", params: null, preview: null, summary: a.summary });
  });

  it("deleting a night cascades to its items", () => {
    const db = memoryDb();
    const n = insertNight(db, { night: "2026-11-24", status: "done" });
    insertStagedAction(db, base(n.id));
    db.sqlite.prepare("DELETE FROM night_shift_nights WHERE id = ?").run(n.id);
    expect(listStagedActions(db, n.id)).toEqual([]);
  });
});
