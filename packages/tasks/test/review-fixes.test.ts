import { FakeClock, FakePermissionBroker } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { createTaskHandlers, TaskWorkerPool } from "../src/index.ts";
import { THREAD, testEngine } from "./helpers.ts";
import { ControlledLoop, clockTimers } from "./loops.ts";

const INPUT = { threadId: THREAD, title: "t", goal: "g", createdFrom: "chat" as const };
const Q = [
  { question: "Q?", header: "Q", options: [{ label: "a" }, { label: "b" }], multiSelect: false },
];
const LEASE = 30_000;

function pool(overrides: Partial<ConstructorParameters<typeof TaskWorkerPool>[0]> = {}) {
  const clock = new FakeClock();
  const { engine } = testEngine({ clock });
  const loop = new ControlledLoop();
  const broker = new FakePermissionBroker({ clock });
  let n = 0;
  const p = new TaskWorkerPool({
    engine,
    loop,
    clock,
    broker,
    timers: clockTimers(clock),
    leaseMs: LEASE,
    isReplaySafe: (t) => t === "search",
    newRunId: () => `run_${++n}`,
    ...overrides,
  });
  return { clock, engine, loop, broker, pool: p };
}

describe("unsafe steps are never reset to pending", () => {
  it("leaving running by any path settles in-flight steps (unsafe → uncertain)", async () => {
    const { engine } = testEngine();
    const task = await engine.create(INPUT);
    await engine.claim("w", { leaseMs: LEASE });
    await engine.checkpoint(task.id, { stepId: "s1", replaySafe: false, status: "running" });
    await engine.checkpoint(task.id, { stepId: "s0", replaySafe: true, status: "running" });
    await engine.updateStatus(task.id, "failed");
    const cps = await engine.checkpoints(task.id);
    expect(cps.map((c) => [c.stepId, c.status])).toEqual([
      ["s1", "uncertain"],
      ["s0", "failed"],
    ]);
    await engine.retry(task.id, { fromStepId: "s1" });
    expect((await engine.checkpoints(task.id)).map((c) => c.status)).toEqual([
      "uncertain",
      "pending",
    ]);
  });

  it("retry never re-runs a completed unsafe step", async () => {
    const { engine } = testEngine();
    const task = await engine.create(INPUT);
    await engine.claim("w", { leaseMs: LEASE });
    await engine.checkpoint(task.id, { stepId: "send", replaySafe: false, status: "done" });
    await engine.checkpoint(task.id, { stepId: "read", replaySafe: true, status: "done" });
    await engine.updateStatus(task.id, "failed");
    await engine.retry(task.id, { fromStepId: "send" });
    expect((await engine.checkpoints(task.id)).map((c) => c.status)).toEqual(["done", "pending"]);
  });

  it("a budget stop mid-step leaves the unsafe step uncertain", async () => {
    const { engine, loop, pool: p } = pool();
    const task = await engine.create({ ...INPUT, budget: { maxSteps: 0 } });
    const next = loop.nextTurn();
    const report = p.runOnce();
    const turn = await next;
    turn.emit({ type: "tool_call", toolCallId: "pay", tool: "stripe.pay", status: "running" });
    expect((await report)?.outcome).toBe("budget_exceeded");
    expect((await engine.checkpoints(task.id))[0]?.status).toBe("uncertain");
  });

  it("updateStatus cannot set running without a claim", async () => {
    const { engine } = testEngine();
    const task = await engine.create(INPUT);
    await expect(engine.updateStatus(task.id, "running")).rejects.toMatchObject({
      code: "invalid_params",
    });
  });
});

describe("parking edge cases", () => {
  it("a task paused while awaiting input is claimable once answered and resumed", async () => {
    const { engine } = testEngine();
    const task = await engine.create(INPUT);
    const req = await engine.requestInput(task.id, Q);
    await engine.pause(task.id);
    await engine.answerInput(req.id, { "Q?": "a" });
    expect((await engine.resume(task.id)).status).toBe("queued");
    expect((await engine.claim("w", { leaseMs: LEASE }))?.taskId).toBe(task.id);
  });
});

describe("worker races", () => {
  it("a stale turn's cleanup does not unregister the newer turn of the same task", async () => {
    const { engine, loop, pool: p } = pool();
    const task = await engine.create(INPUT);
    const n1 = loop.nextTurn();
    const r1 = p.runOnce({ owner: "a" });
    const turn1 = await n1;
    await engine.pause(task.id);
    await engine.resume(task.id);
    const n2 = loop.nextTurn();
    const r2 = p.runOnce({ owner: "b" });
    const turn2 = await n2;
    await r1; // turn 1 was aborted by the pause and finishes now
    expect(turn1.input.signal?.aborted).toBe(true);
    await engine.cancel(task.id);
    expect(loop.cancelled).toContain(turn2.runId);
    await r2;
  });

  it("lease-checked settle writes lose to a pause committed in between", async () => {
    const { engine } = testEngine();
    const task = await engine.create(INPUT);
    const lease = await engine.claim("w", { leaseMs: LEASE });
    if (lease === undefined) throw new Error("no lease");
    await engine.pause(task.id); // e.g. from another process
    await expect(engine.updateStatus(task.id, "done", {}, { lease })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      engine.parkForApproval(task.id, { approvalId: "apr_1" }, { lease }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await engine.get(task.id))?.status).toBe("paused");
  });

  it("a run the loop cancels on its own pauses the task instead of spinning", async () => {
    const { engine, loop, pool: p } = pool();
    const task = await engine.create(INPUT);
    const next = loop.nextTurn();
    const report = p.runOnce();
    const turn = await next;
    turn.end("cancelled");
    expect((await report)?.task?.status).toBe("paused");
    expect(await p.runOnce()).toBeUndefined();
    void task;
  });

  it("a missing approval event fails the task instead of re-queueing it", async () => {
    const { engine, loop, pool: p } = pool();
    await engine.create(INPUT);
    const next = loop.nextTurn();
    const report = p.runOnce();
    (await next).end("awaiting_approval");
    expect((await report)?.task?.status).toBe("failed");
  });

  it("resume items survive a turn that fails to start", async () => {
    const {
      engine,
      loop,
      pool: p,
    } = pool({
      permissionModeFor: () => {
        throw new Error("settings unavailable");
      },
    });
    const task = await engine.create(INPUT);
    const req = await engine.requestInput(task.id, Q);
    await engine.answerInput(req.id, { "Q?": "b" });
    const r = await p.runOnce();
    expect(r?.task?.status).toBe("failed");
    await engine.retry(task.id);
    const kinds = engine.getRecord(task.id)?.resume.map((i) => i.kind);
    expect(kinds).toEqual(["input_answered", "retry"]);
    void loop;
  });
});

describe("keyset pagination", () => {
  it("tasks.list pages stay stable while earlier rows are updated", async () => {
    const { engine, clock } = testEngine();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push((await engine.create(INPUT)).id);
      clock.advance(10);
    }
    const h = createTaskHandlers({ engine });
    const p1 = await h["tasks.list"]({ limit: 2 });
    // The newest task is touched: it moves to the top but must not reappear on page 2.
    await engine.attachResources(ids[4] as string, { sandboxId: "sb" });
    clock.advance(10);
    const p2 = await h["tasks.list"]({ limit: 2, cursor: p1.nextCursor ?? "" });
    const p3 = await h["tasks.list"]({ limit: 2, cursor: p2.nextCursor ?? "" });
    const seen = [...p1.tasks, ...p2.tasks, ...p3.tasks].map((t) => t.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(5);
  });
});
