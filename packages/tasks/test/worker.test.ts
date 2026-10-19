import { APPROVAL_TTL_MS } from "@psyche/protocol";
import { FakeClock, FakeNotifier, FakePermissionBroker } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { type SqliteTaskEngine, TaskWorkerPool, type TaskWorkerPoolOptions } from "../src/index.ts";
import { THREAD, testDb, testEngine } from "./helpers.ts";
import { ControlledLoop, clockTimers, flush, frozenTimers, type TurnHandle } from "./loops.ts";

const LEASE = 30_000;
const SAFE = new Set(["browser.read_text", "search"]);

function setup(overrides: Partial<TaskWorkerPoolOptions> = {}) {
  const clock = new FakeClock();
  const { engine, db } = testEngine({ clock });
  const loop = new ControlledLoop();
  const broker = new FakePermissionBroker({ clock });
  const notifier = new FakeNotifier({ clock });
  const pool = new TaskWorkerPool({
    engine,
    loop,
    clock,
    timers: clockTimers(clock),
    broker,
    notifier,
    leaseMs: LEASE,
    owner: "w1",
    isReplaySafe: (t) => SAFE.has(t),
    newRunId: (() => {
      let n = 0;
      return () => `run_${++n}`;
    })(),
    ...overrides,
  });
  return { clock, engine, db, loop, broker, notifier, pool };
}

async function newTask(engine: SqliteTaskEngine, extra: Record<string, unknown> = {}) {
  return engine.create({
    threadId: THREAD,
    title: "Book a table",
    goal: "Book a table for two on Friday",
    createdFrom: "chat",
    ...extra,
  });
}

/** Start `runOnce` and return the live turn plus the eventual report. */
async function startTurn(pool: TaskWorkerPool, loop: ControlledLoop) {
  const next = loop.nextTurn();
  const report = pool.runOnce();
  const turn = await next;
  return { turn, report };
}

async function requestApproval(broker: FakePermissionBroker, turn: TurnHandle, taskId: string) {
  return broker.requestApproval({
    kind: "send_email",
    summary: "Send the booking confirmation to alice@example.com",
    details: { to: ["alice@example.com"] },
    bindingHash: `sha256:${"ab".repeat(32)}`,
    grantKey: "email.send|example.com",
    requestedBy: { runId: turn.runId, taskId, threadId: THREAD, toolCallId: "tc_send" },
    sideEffect: "destructive",
    surfaces: ["desktop"],
    taint: false,
  });
}

describe("TaskWorkerPool", () => {
  it("runs a turn, records checkpoints and Activity, and settles done", async () => {
    const { engine, loop, pool, notifier } = setup();
    const task = await newTask(engine);
    const { turn, report } = await startTurn(pool, loop);
    expect(turn.input.taskId).toBe(task.id);
    expect(turn.input.input.text).toContain(task.goal);
    turn.emit({ type: "tool_call", toolCallId: "tc1", tool: "search", status: "running" });
    turn.emit({
      type: "tool_call",
      toolCallId: "tc1",
      tool: "search",
      status: "ok",
      level1: "Searched restaurants near Mission",
    });
    turn.emit({ type: "chat.delta", messageId: "m1", delta: "Booked for 7pm." });
    turn.end("final");
    const r = await report;
    expect(r?.outcome).toBe("final");
    expect(r?.task?.status).toBe("done");
    expect(r?.task?.summary).toBe("Booked for 7pm.");
    const cps = await engine.checkpoints(task.id);
    expect(cps).toMatchObject([{ stepId: "tc1", status: "done", replaySafe: true }]);
    expect((await engine.actions(task.id)).map((a) => a.level1)).toEqual([
      "Searched restaurants near Mission",
    ]);
    expect((await notifier.list()).map((n) => n.kind)).toEqual(["task_done"]);
  });

  it("expired-lease recovery: a frozen worker's task is resumed by another from its checkpoint", async () => {
    const clock = new FakeClock();
    const db = testDb(clock);
    const { engine } = testEngine({ clock, db });
    const loopA = new ControlledLoop();
    const frozen = new TaskWorkerPool({
      engine,
      loop: loopA,
      clock,
      timers: frozenTimers,
      leaseMs: LEASE,
      owner: "a",
      isReplaySafe: (t) => SAFE.has(t),
    });
    const task = await newTask(engine);
    const a = await startTurn(frozen, loopA);
    a.turn.emit({ type: "tool_call", toolCallId: "tc1", tool: "search", status: "running" });
    a.turn.emit({ type: "tool_call", toolCallId: "tc1", tool: "search", status: "ok" });
    a.turn.emit({ type: "tool_call", toolCallId: "tc2", tool: "search", status: "running" });
    await flush();
    // Worker A stops renewing (crash / sleep). Before expiry nobody else can take the task.
    const loopB = new ControlledLoop();
    const b = new TaskWorkerPool({
      engine,
      loop: loopB,
      clock,
      timers: clockTimers(clock),
      leaseMs: LEASE,
      owner: "b",
      isReplaySafe: (t) => SAFE.has(t),
    });
    expect(await b.runOnce()).toBeUndefined();
    clock.advance(LEASE + 1);
    const next = loopB.nextTurn();
    const reportB = b.runOnce();
    const turnB = await next;
    const t = await engine.get(task.id);
    expect(t?.leaseOwner).toBe("b/0");
    expect(t?.attempt).toBe(2);
    expect(turnB.input.input.text).toContain("Completed steps: tc1");
    expect(turnB.input.input.text).toContain("stopped unexpectedly");
    const cps = await engine.checkpoints(task.id);
    // The safe in-flight step is replayable again; the done one is kept.
    expect(cps.map((c) => [c.stepId, c.status])).toEqual([
      ["tc1", "done"],
      ["tc2", "pending"],
    ]);
    turnB.end("final");
    expect((await reportB)?.task?.status).toBe("done");
    // Worker A wakes up late: its turn ends but it no longer holds the lease, so it changes nothing.
    a.turn.end("final");
    const ra = await a.report;
    expect(ra?.outcome).toBe("lease_lost");
    expect((await engine.get(task.id))?.status).toBe("done");
    expect((await engine.actions(task.id)).some((x) => x.level2.tool === "task.recover")).toBe(
      true,
    );
  });

  it("crash between an unsafe step's start and its receipt leaves it uncertain, never replayed", async () => {
    const clock = new FakeClock();
    const { engine } = testEngine({ clock });
    const loopA = new ControlledLoop();
    const crashed = new TaskWorkerPool({
      engine,
      loop: loopA,
      clock,
      timers: frozenTimers,
      leaseMs: LEASE,
      owner: "a",
      isReplaySafe: (t) => SAFE.has(t),
    });
    const task = await newTask(engine);
    const a = await startTurn(crashed, loopA);
    a.turn.emit({ type: "tool_call", toolCallId: "pay", tool: "stripe.pay", status: "running" });
    await flush();
    expect((await engine.checkpoints(task.id))[0]).toMatchObject({
      stepId: "pay",
      replaySafe: false,
      status: "running",
    });
    // The process dies here: no receipt, no renewal. A restart sweeps expired leases.
    clock.advance(LEASE + 1);
    expect(await engine.recoverExpired()).toEqual([task.id]);
    const cps = await engine.checkpoints(task.id);
    expect(cps[0]?.status).toBe("uncertain");
    expect((await engine.get(task.id))?.status).toBe("queued");

    const loopB = new ControlledLoop();
    const b = new TaskWorkerPool({
      engine,
      loop: loopB,
      clock,
      timers: clockTimers(clock),
      leaseMs: LEASE,
      owner: "b",
      isReplaySafe: (t) => SAFE.has(t),
    });
    const next = loopB.nextTurn();
    const report = b.runOnce();
    const turn = await next;
    expect(turn.input.input.text).toMatch(/Uncertain steps .*do NOT repeat.*: pay/);
    turn.end("final");
    await report;
    // Still uncertain until reconciled; a retry from scratch would not reset it either.
    expect((await engine.checkpoints(task.id))[0]?.status).toBe("uncertain");
    await engine.reconcile(task.id, "pay", { status: "done", receiptId: "rcp_1" });
    expect((await engine.checkpoints(task.id))[0]).toMatchObject({
      status: "done",
      receiptId: "rcp_1",
    });
  });

  it("cancellation mid-step revokes the run's authority at once", async () => {
    const { engine, loop, pool, broker } = setup();
    const task = await newTask(engine);
    const { turn, report } = await startTurn(pool, loop);
    turn.emit({ type: "tool_call", toolCallId: "send", tool: "email.send", status: "running" });
    await flush();
    const issued = await requestApproval(broker, turn, task.id);
    await engine.cancel(task.id, "Owner stopped it");
    // The turn is aborted and the loop told; the pending approval can no longer be answered.
    expect(loop.cancelled).toEqual([turn.runId]);
    expect(turn.input.signal?.aborted).toBe(true);
    await flush();
    expect((await broker.get(issued.approval.id))?.status).toBe("invalidated");
    const r = await report;
    expect(r?.outcome).toBe("stopped");
    expect(r?.task?.status).toBe("cancelled");
    expect((await engine.checkpoints(task.id))[0]?.status).toBe("uncertain");
    // An already-dispatched request may still finish; its result is reconciled, not replayed.
    await expect(engine.claim("w2", { leaseMs: LEASE })).resolves.toBeUndefined();
  });

  it("pause stops the turn; resume re-queues and the next turn is told", async () => {
    const { engine, loop, pool } = setup();
    const task = await newTask(engine);
    const { turn, report } = await startTurn(pool, loop);
    turn.emit({ type: "tool_call", toolCallId: "tc1", tool: "search", status: "running" });
    await flush();
    await engine.pause(task.id);
    expect((await report)?.outcome).toBe("stopped");
    expect((await engine.get(task.id))?.status).toBe("paused");
    expect(await pool.runOnce()).toBeUndefined();
    expect((await engine.resume(task.id)).status).toBe("queued");
    const second = await startTurn(pool, loop);
    expect(second.turn.input.input.text).toContain("resumed this task");
    second.turn.end("final");
    expect((await second.report)?.task?.status).toBe("done");
    expect((await engine.get(task.id))?.attempt).toBe(2);
  });

  it("input request round trip: park, notify, answer, resume with the answer", async () => {
    const { engine, loop, pool, notifier } = setup();
    const task = await newTask(engine);
    const { turn, report } = await startTurn(pool, loop);
    const questions = [
      {
        question: "Which time?",
        header: "Time",
        options: [{ label: "7pm" }, { label: "8pm" }],
        multiSelect: false,
      },
    ];
    turn.emit({
      type: "question",
      inputRequest: {
        id: "inp_1",
        taskId: task.id,
        threadId: THREAD,
        questions,
        status: "open",
        answer: null,
        createdAt: new Date().toISOString(),
        answeredAt: null,
        answeredByDeviceId: null,
      },
    });
    turn.end("awaiting_input");
    const r = await report;
    expect(r?.task?.status).toBe("awaiting_input");
    expect(engine.inputRequests({ taskId: task.id, status: "open" }).map((i) => i.id)).toEqual([
      "inp_1",
    ]);
    expect((await notifier.list()).map((n) => [n.kind, n.body])).toEqual([
      ["input_needed", "Which time?"],
    ]);
    // Input requests never time out.
    expect(await pool.runOnce()).toBeUndefined();
    await engine.answerInput("inp_1", { "Which time?": "7pm" }, { deviceId: "dev_1" });
    const second = await startTurn(pool, loop);
    expect(second.turn.input.input.text).toContain('"Which time?":"7pm"');
    second.turn.end("final");
    expect((await second.report)?.task?.status).toBe("done");
  });

  it("approval expiry re-queues the step; approval grants resume it", async () => {
    const { engine, loop, pool, broker, clock } = setup();
    const task = await newTask(engine);
    const { turn, report } = await startTurn(pool, loop);
    turn.emit({ type: "tool_call", toolCallId: "tc_send", tool: "email.send", status: "pending" });
    const issued = await requestApproval(broker, turn, task.id);
    await engine.checkpoint(task.id, { stepId: "tc_send", replaySafe: false, status: "pending" });
    turn.emit({ type: "approval_requested", approval: issued.approval });
    turn.end("awaiting_approval");
    expect((await report)?.task?.status).toBe("awaiting_approval");
    expect(await pool.runOnce()).toBeUndefined();

    clock.advance(APPROVAL_TTL_MS + 1);
    await flush();
    expect((await broker.get(issued.approval.id))?.status).toBe("expired");
    expect((await engine.get(task.id))?.status).toBe("queued");
    expect((await engine.checkpoints(task.id))[0]?.status).toBe("pending");
    const lines = (await engine.actions(task.id)).map((a) => a.level1);
    expect(lines).toContain("Approval expired; step re-queued");

    // The re-queued step asks again; this time the owner approves.
    const second = await startTurn(pool, loop);
    expect(second.turn.input.input.text).toContain(`Approval ${issued.approval.id} was expired`);
    const again = await requestApproval(broker, second.turn, task.id);
    second.turn.emit({ type: "approval_requested", approval: again.approval });
    second.turn.end("awaiting_approval");
    await second.report;
    clock.advance(1_000);
    await broker.answer({
      approvalId: again.approval.id,
      answerToken: again.answerTokens.desktop as string,
      decision: "approve",
      scope: "once",
      decidedBy: { kind: "device", deviceId: "dev_1" },
    } as Parameters<typeof broker.answer>[0]);
    await flush();
    expect((await engine.get(task.id))?.status).toBe("queued");
    const third = await startTurn(pool, loop);
    expect(third.turn.input.input.text).toContain("was granted");
    third.turn.end("final");
    expect((await third.report)?.task?.status).toBe("done");
  });

  it("a restart's re-issued approval is re-bound to the parked task", async () => {
    const { engine, loop, pool, broker } = setup();
    const task = await newTask(engine);
    const { turn, report } = await startTurn(pool, loop);
    const issued = await requestApproval(broker, turn, task.id);
    turn.emit({ type: "approval_requested", approval: issued.approval });
    turn.end("awaiting_approval");
    await report;
    const fresh = await broker.reissue();
    await flush();
    // The invalidation did not unpark the task.
    expect((await engine.get(task.id))?.status).toBe("awaiting_approval");
    await pool.onApprovalsReissued(fresh);
    expect(engine.parkedOnApprovals()).toEqual([
      { taskId: task.id, approvalId: fresh[0]?.approval.id },
    ]);
  });

  it("budgets stop a runaway turn", async () => {
    const { engine, loop, pool } = setup();
    const task = await newTask(engine, { budget: { maxSteps: 2 } });
    const { turn, report } = await startTurn(pool, loop);
    for (const id of ["a", "b", "c"]) {
      turn.emit({ type: "tool_call", toolCallId: id, tool: "search", status: "running" });
      turn.emit({ type: "tool_call", toolCallId: id, tool: "search", status: "ok" });
    }
    const r = await report;
    expect(r?.outcome).toBe("budget_exceeded");
    expect(r?.task?.status).toBe("failed");
    expect(r?.task?.summary).toContain("step budget (2) exceeded");
    expect(loop.cancelled).toEqual([turn.runId]);
    void task;
  });

  it("unattended tasks run in unattended mode and NO_REPLY settles quietly", async () => {
    const { engine, loop, pool, notifier } = setup();
    await newTask(engine, { createdFrom: "automation", mode: "unattended" });
    const { turn, report } = await startTurn(pool, loop);
    expect(turn.input.mode).toBe("unattended");
    turn.end("no_reply");
    const r = await report;
    expect(r?.task?.outcome).toEqual({ result: "no_reply" });
    expect(await notifier.list()).toHaveLength(0);
  });

  it("renews its lease while a long turn runs", async () => {
    const { engine, loop, pool, clock } = setup();
    const task = await newTask(engine);
    const { turn, report } = await startTurn(pool, loop);
    for (let i = 0; i < 6; i += 1) {
      clock.advance(LEASE / 2);
      await flush();
    }
    expect(await engine.claim("intruder", { leaseMs: LEASE })).toBeUndefined();
    turn.end("final");
    expect((await report)?.task?.status).toBe("done");
    void task;
  });

  it("start() runs queued tasks in the background and poke() wakes idle slots", async () => {
    const { engine, loop, pool } = setup({ concurrency: 2 });
    await pool.start();
    const next = loop.nextTurn();
    const task = await newTask(engine);
    pool.poke();
    const turn = await next;
    turn.end("final");
    await flush();
    expect((await engine.get(task.id))?.status).toBe("done");
    await pool.stop();
  });
});
