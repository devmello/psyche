import type { ForkReport, PlanComparison } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  appendMessage,
  createThread,
  deletePlanFork,
  deletePlanForkBranch,
  deleteThread,
  getLivePlanForkForThread,
  getPlanFork,
  getPlanForkBranch,
  getPlanForkBranchByThread,
  insertNight,
  insertPlanFork,
  insertPlanForkBranch,
  insertStagedAction,
  listPlanForkBranches,
  listPlanForks,
  listPlanForksByStatus,
  listStagedActionsForBranch,
  updatePlanFork,
  updatePlanForkBranch,
} from "../src/index.ts";
import { memoryDb } from "./helpers.ts";

const report: ForkReport = {
  summary: "Austin costs more but is closer to family.",
  steps: [{ id: "s1", text: "Book a viewing", who: "you", when: "2026-12-01" }],
  costs: [
    {
      id: "c1",
      label: "Rent",
      amount: 1850,
      currency: "USD",
      period: "month",
      estimate: false,
      cites: [{ callId: "call1", ref: "mail:9", source: "mail" }],
    },
  ],
  dates: [
    {
      id: "d1",
      label: "Lease ends",
      date: "2027-03-31",
      kind: "deadline",
      estimate: true,
      cites: [],
      unsourced: true,
    },
  ],
  people: [{ id: "p1", name: "Sam", effect: "Moves away", cites: [] }],
  tradeoffs: [{ id: "t1", giveUp: "Current job", cites: [] }],
  risks: [{ id: "r1", text: "Housing is tight", likelihood: "medium", cites: [] }],
  openQuestions: [{ id: "q1", text: "Can the job go remote?" }],
};

function setup() {
  const db = memoryDb();
  const parent = createThread(db, { kind: "main", sessionKey: "owner:main" });
  const m = appendMessage(
    db,
    {
      threadId: parent.id,
      role: "user",
      blocks: [{ type: "text", text: "Move?" }],
      provenance: "owner",
    },
    { expectedWriterRunId: null },
  );
  const fork = insertPlanFork(db, { threadId: parent.id, forkMessageId: m.id });
  const branch = (ord: number, label = `Option ${ord}`) => {
    const t = createThread(db, {
      kind: "subagent",
      sessionKey: `fork:${fork.id}:${ord}`,
      parentThreadId: parent.id,
    });
    return insertPlanForkBranch(db, {
      forkId: fork.id,
      ord,
      label,
      premise: `Assume ${label}`,
      threadId: t.id,
    });
  };
  return { db, parent, message: m, fork, branch };
}

const staged = (forkBranchId: string, over: Record<string, unknown> = {}) => ({
  forkBranchId,
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

describe("plan forks repo (real SQLite)", () => {
  it("writes then reads every fork column, with the $1.00 default budget", () => {
    const { db, parent, message, fork } = setup();
    expect(fork).toMatchObject({
      threadId: parent.id,
      forkMessageId: message.id,
      status: "running",
      budgetUsd: 1,
      spentUsd: 0,
      tokens: 0,
      comparison: null,
      takenBranchId: null,
      takeApprovalId: null,
      createdByDeviceId: null,
      expiresAt: null,
      finishedAt: null,
      error: null,
    });
    expect(getPlanFork(db, fork.id)).toEqual(fork);
    const comparison: PlanComparison = {
      headline: "Austin costs more",
      rows: [
        {
          dimension: "cost",
          label: "Rent",
          cells: [{ branchId: "b1", itemIds: ["c1"], note: "higher" }],
          differs: true,
        },
      ],
      betterIf: [{ branchId: "b1", text: "Better if you want family close" }],
    };
    const done = updatePlanFork(db, fork.id, {
      status: "ready",
      error: "none",
      spentUsd: 0.42,
      tokens: 9000,
      comparison,
      takenBranchId: "b1",
      takeApprovalId: "ap1",
      expiresAt: "2026-12-01T00:00:00.000Z",
      finishedAt: "2026-11-24T10:00:00.000Z",
    });
    expect(done).toMatchObject({
      status: "ready",
      error: "none",
      spentUsd: 0.42,
      tokens: 9000,
      comparison,
      takenBranchId: "b1",
      takeApprovalId: "ap1",
      expiresAt: "2026-12-01T00:00:00.000Z",
      finishedAt: "2026-11-24T10:00:00.000Z",
    });
    expect(getPlanFork(db, fork.id)).toEqual(done);
    expect(updatePlanFork(db, fork.id, { comparison: null })?.comparison).toBeNull();
  });

  it("stores the device that started it and a custom budget, and refuses one out of range", () => {
    const { db, parent } = setup();
    const f = insertPlanFork(db, {
      threadId: parent.id,
      status: "ready",
      budgetUsd: 5,
      createdByDeviceId: "dev1",
    });
    expect(f).toMatchObject({ budgetUsd: 5, createdByDeviceId: "dev1" });
    expect(
      insertPlanFork(db, { threadId: parent.id, status: "ready", budgetUsd: 0.1 }).budgetUsd,
    ).toBe(0.1);
    expect(() =>
      insertPlanFork(db, { threadId: parent.id, status: "ready", budgetUsd: 5.01 }),
    ).toThrow(RangeError);
    expect(() =>
      insertPlanFork(db, { threadId: parent.id, status: "ready", budgetUsd: 0.09 }),
    ).toThrow(RangeError);
    // The table CHECK refuses it even when the repo is bypassed.
    expect(() =>
      db.sqlite.prepare("UPDATE plan_forks SET budget_usd = 6 WHERE id = ?").run(f.id),
    ).toThrow(/CHECK/);
  });

  it("writes then reads every branch column", () => {
    const { db, fork, branch } = setup();
    const b = branch(0, "Move to Austin");
    expect(b).toMatchObject({
      forkId: fork.id,
      ord: 0,
      label: "Move to Austin",
      premise: "Assume Move to Austin",
      taskId: null,
      status: "queued",
      error: null,
      report: null,
      readOwnerOnly: false,
      taint: false,
      taintSources: [],
      spentUsd: 0,
      tokens: 0,
      startedAt: null,
      finishedAt: null,
    });
    expect(getPlanForkBranch(db, b.id)).toEqual(b);
    const done = updatePlanForkBranch(db, b.id, {
      taskId: "task1",
      status: "reported",
      error: "e",
      report,
      readOwnerOnly: true,
      taint: true,
      taintSources: [{ sourceKind: "mail" }],
      spentUsd: 0.2,
      tokens: 4321,
      startedAt: "2026-11-24T09:00:00.000Z",
      finishedAt: "2026-11-24T09:05:00.000Z",
    });
    expect(done).toMatchObject({
      taskId: "task1",
      status: "reported",
      error: "e",
      report,
      readOwnerOnly: true,
      taint: true,
      taintSources: [{ sourceKind: "mail" }],
      spentUsd: 0.2,
      tokens: 4321,
      startedAt: "2026-11-24T09:00:00.000Z",
      finishedAt: "2026-11-24T09:05:00.000Z",
    });
    expect(getPlanForkBranch(db, b.id)).toEqual(done);
    expect(getPlanForkBranchByThread(db, b.threadId)).toEqual(done);
    expect(getPlanForkBranchByThread(db, "nope")).toBeNull();
    expect(updatePlanForkBranch(db, b.id, { report: null })?.report).toBeNull();
  });

  it("lists branches by ord, forks newest first and forks by status", () => {
    const { db, parent, fork, branch } = setup();
    const b1 = branch(1);
    const b0 = branch(0);
    expect(listPlanForkBranches(db, fork.id).map((b) => b.id)).toEqual([b0.id, b1.id]);
    updatePlanFork(db, fork.id, { status: "ready" });
    const second = insertPlanFork(db, { threadId: parent.id });
    expect(listPlanForks(db, parent.id).map((f) => f.id)).toEqual([second.id, fork.id]);
    expect(listPlanForksByStatus(db, ["running"]).map((f) => f.id)).toEqual([second.id]);
    expect(listPlanForksByStatus(db, [])).toEqual([]);
    expect(getLivePlanForkForThread(db, parent.id)?.id).toBe(second.id);
  });

  it("allows one running or comparing fork per thread", () => {
    const { db, parent, fork } = setup();
    expect(() => insertPlanFork(db, { threadId: parent.id })).toThrow(/UNIQUE/);
    expect(() => insertPlanFork(db, { threadId: parent.id, status: "comparing" })).toThrow(
      /UNIQUE/,
    );
    // A finished fork frees the slot; finished forks can pile up.
    updatePlanFork(db, fork.id, { status: "taken" });
    insertPlanFork(db, { threadId: parent.id, status: "ready" });
    insertPlanFork(db, { threadId: parent.id, status: "expired" });
    insertPlanFork(db, { threadId: parent.id });
    expect(getLivePlanForkForThread(db, parent.id)?.status).toBe("running");
  });

  it("refuses a bad status, a bad ord, a duplicate ord and a missing thread", () => {
    const { db, parent, fork, branch } = setup();
    expect(() => insertPlanFork(db, { threadId: parent.id, status: "bogus" as never })).toThrow(
      /CHECK/,
    );
    expect(() => insertPlanFork(db, { threadId: "no-such-thread" })).toThrow(/FOREIGN/);
    branch(0);
    expect(() => branch(0)).toThrow(/UNIQUE/);
    expect(() => branch(4)).toThrow(/CHECK/);
    const t = createThread(db, { kind: "subagent", sessionKey: "fork:x" });
    const bad = (over: Record<string, unknown>) =>
      insertPlanForkBranch(db, {
        forkId: fork.id,
        ord: 2,
        label: "L",
        premise: "P",
        threadId: t.id,
        ...over,
      });
    expect(() => bad({ label: "" })).toThrow(/CHECK/);
    expect(() => bad({ label: "x".repeat(41) })).toThrow(/CHECK/);
    expect(() => bad({ premise: "x".repeat(281) })).toThrow(/CHECK/);
    expect(() => bad({ status: "bogus" })).toThrow(/CHECK/);
    expect(() => bad({ forkId: "no-such-fork" })).toThrow(/FOREIGN/);
    expect(bad({ label: "x".repeat(40), premise: "y".repeat(280) }).ord).toBe(2);
  });

  it("deleting a branch deletes its staged items and leaves other origins alone", () => {
    const { db, fork, branch } = setup();
    const a = branch(0);
    const b = branch(1);
    const night = insertNight(db, { night: "2026-11-24", status: "running" });
    insertStagedAction(db, staged(a.id));
    insertStagedAction(db, staged(a.id, { seq: 1, targetKey: "thread:2" }));
    const keep = insertStagedAction(db, staged(b.id));
    const nightItem = insertStagedAction(db, {
      ...staged(a.id),
      forkBranchId: null,
      nightId: night.id,
    } as never);
    expect(listStagedActionsForBranch(db, a.id)).toHaveLength(2);
    expect(deletePlanForkBranch(db, a.id)).toBe(true);
    expect(getPlanForkBranch(db, a.id)).toBeNull();
    expect(listStagedActionsForBranch(db, a.id)).toEqual([]);
    expect(listStagedActionsForBranch(db, b.id).map((i) => i.id)).toEqual([keep.id]);
    expect(
      db.sqlite.prepare("SELECT id FROM staged_actions WHERE night_id = ?").all(night.id),
    ).toEqual([{ id: nightItem.id }]);
    expect(deletePlanForkBranch(db, a.id)).toBe(false);
    expect(getPlanFork(db, fork.id)).not.toBeNull();
  });

  it("deleting a fork deletes its branches and their staged items", () => {
    const { db, fork, branch } = setup();
    const a = branch(0);
    const b = branch(1);
    insertStagedAction(db, staged(a.id));
    insertStagedAction(db, staged(b.id));
    expect(deletePlanFork(db, fork.id)).toBe(true);
    expect(getPlanFork(db, fork.id)).toBeNull();
    expect(listPlanForkBranches(db, fork.id)).toEqual([]);
    expect(listStagedActionsForBranch(db, a.id)).toEqual([]);
    expect(listStagedActionsForBranch(db, b.id)).toEqual([]);
    expect(deletePlanFork(db, fork.id)).toBe(false);
  });

  it("a raw delete and the thread cascades still remove staged items (the trigger)", () => {
    const { db, parent, fork, branch } = setup();
    const a = branch(0);
    const b = branch(1);
    insertStagedAction(db, staged(a.id));
    insertStagedAction(db, staged(b.id));
    // A raw delete of the branch row, bypassing the repo function.
    db.sqlite.prepare("DELETE FROM plan_fork_branches WHERE id = ?").run(a.id);
    expect(listStagedActionsForBranch(db, a.id)).toEqual([]);
    expect(listStagedActionsForBranch(db, b.id)).toHaveLength(1);
    // Deleting the branch's own thread cascades to the branch and its items.
    const bThread = b.threadId;
    expect(deleteThread(db, bThread)).toBe(true);
    expect(getPlanForkBranch(db, b.id)).toBeNull();
    expect(listStagedActionsForBranch(db, b.id)).toEqual([]);
    // Deleting the parent thread cascades to forks, branches and items.
    const c = branch(2);
    insertStagedAction(db, staged(c.id));
    expect(deleteThread(db, parent.id)).toBe(true);
    expect(getPlanFork(db, fork.id)).toBeNull();
    expect(listStagedActionsForBranch(db, c.id)).toEqual([]);
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM staged_actions").get()).toEqual({ n: 0 });
  });

  it("deleting the fork point message keeps the fork and clears the pointer", () => {
    const { db, message, fork } = setup();
    db.sqlite.prepare("DELETE FROM messages WHERE id = ?").run(message.id);
    expect(getPlanFork(db, fork.id)?.forkMessageId).toBeNull();
  });
});
