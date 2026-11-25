import { APPROVAL_TTL_MS } from "@psyche/protocol";
import { FakeClock, FakePermissionBroker } from "@psyche/testing";
import { describe, expect, it, vi } from "vitest";
import {
  createWakeDetector,
  NEEDS_APPROVAL_RESULT,
  type SqliteTaskEngine,
  TaskWorkerPool,
} from "../src/index.ts";
import { THREAD, testEngine } from "./helpers.ts";
import { ControlledLoop, flush, frozenTimers } from "./loops.ts";

const LEASE = 30_000;

function setup() {
  const clock = new FakeClock();
  const { engine } = testEngine({ clock });
  const loop = new ControlledLoop();
  const broker = new FakePermissionBroker({ clock });
  const pool = new TaskWorkerPool({
    engine,
    loop,
    clock,
    timers: frozenTimers,
    broker,
    leaseMs: LEASE,
    owner: "w1",
    newRunId: (() => {
      let n = 0;
      return () => `run_${++n}`;
    })(),
  });
  return { clock, engine, loop, broker, pool };
}

const newTask = (
  engine: SqliteTaskEngine,
  createdFrom: "chat" | "automation" | "subagent" = "chat",
  mode?: "unattended",
) =>
  engine.create({
    threadId: THREAD,
    title: "t",
    goal: "g",
    createdFrom,
    ...(mode ? { mode } : {}),
  });

describe("sleep and wake: a running turn is never claimed again", () => {
  it("an expired lease on a task this pool is running is not claimed by an idle slot", async () => {
    const { clock, engine, loop, pool } = setup();
    const task = await newTask(engine);
    const next = loop.nextTurn();
    const report = pool.runOnce({ owner: "w1/0" });
    const turn = await next;
    // The Mac sleeps: the wall clock moves past the lease, the turn is alive, no timer ran.
    clock.advance(LEASE * 4);
    const poll = await pool.runOnce({ owner: "w1/1" });
    expect(poll).toBeUndefined();
    expect(loop.turns).toHaveLength(1);
    const t = await engine.get(task.id);
    expect(t?.attempt).toBe(1);
    expect(t?.leaseOwner).toBe("w1/0");
    turn.end("final");
    expect((await report)?.task?.status).toBe("done");
  });

  it("positive control: another pool still claims it once the lease ran out", async () => {
    const { clock, engine, loop, pool } = setup();
    const task = await newTask(engine);
    const next = loop.nextTurn();
    const first = pool.runOnce();
    await next;
    clock.advance(LEASE * 4);
    const claimed = await engine.claim("other", { leaseMs: LEASE });
    expect(claimed?.taskId).toBe(task.id);
    // And an exclusion list keeps a pool off the tasks it names.
    clock.advance(LEASE * 4);
    expect(await engine.claim("w1/1", { leaseMs: LEASE, excludeTaskIds: [task.id] })).toBe(
      undefined,
    );
    void first;
  });

  it("renewLeases() renews an expired lease the pool still holds, so the turn keeps going", async () => {
    const { clock, engine, loop, pool } = setup();
    const task = await newTask(engine);
    const next = loop.nextTurn();
    const report = pool.runOnce();
    const turn = await next;
    clock.advance(LEASE * 4);
    await pool.renewLeases();
    const t = await engine.get(task.id);
    expect(t?.status).toBe("running");
    expect(Date.parse(t?.leaseUntil as string)).toBeGreaterThan(clock.now());
    // Nobody else can take it now.
    expect(await engine.claim("other", { leaseMs: LEASE })).toBeUndefined();
    turn.end("final");
    const r = await report;
    expect(r?.outcome).toBe("final");
    expect(r?.task?.status).toBe("done");
  });

  it("a lease another worker took over is not renewed", async () => {
    const { clock, engine, loop, pool } = setup();
    const task = await newTask(engine);
    const next = loop.nextTurn();
    const report = pool.runOnce();
    const turn = await next;
    clock.advance(LEASE + 1);
    expect((await engine.claim("other", { leaseMs: LEASE }))?.taskId).toBe(task.id);
    await pool.renewLeases();
    await flush();
    turn.end("final");
    expect((await report)?.outcome).toBe("lease_lost");
  });
});

describe("approvals of unattended runs", () => {
  async function parked(createdFrom: "chat" | "automation" | "subagent", mode?: "unattended") {
    const s = setup();
    const task = await newTask(s.engine, createdFrom, mode);
    const next = s.loop.nextTurn();
    const report = s.pool.runOnce();
    const turn = await next;
    const issued = await s.broker.requestApproval({
      kind: "send_email",
      summary: "Send it",
      details: { to: ["a@example.com"] },
      bindingHash: `sha256:${"ab".repeat(32)}`,
      grantKey: "email.send|example.com",
      requestedBy: { runId: turn.runId, taskId: task.id, threadId: THREAD, toolCallId: "tc" },
      sideEffect: "destructive",
      surfaces: ["desktop"],
      taint: false,
    });
    await s.engine.checkpoint(task.id, { stepId: "tc", replaySafe: false, status: "pending" });
    turn.emit({ type: "approval_requested", approval: issued.approval });
    turn.end("awaiting_approval");
    await report;
    return { ...s, task };
  }

  it("an automation run whose approval expires ends as needing approval and is not re-queued", async () => {
    const { clock, engine, pool, task } = await parked("automation", "unattended");
    clock.advance(APPROVAL_TTL_MS + 1);
    await flush();
    const t = await engine.get(task.id);
    expect(t?.status).toBe("cancelled");
    expect(t?.outcome?.result).toBe(NEEDS_APPROVAL_RESULT);
    // No second turn raises the same card.
    expect(await pool.runOnce()).toBeUndefined();
  });

  it("a specialist job an automation started (subagent, unattended) ends the same way", async () => {
    const { clock, engine, task } = await parked("subagent", "unattended");
    clock.advance(APPROVAL_TTL_MS + 1);
    await flush();
    const t = await engine.get(task.id);
    expect(t?.status).toBe("cancelled");
    expect(t?.outcome?.result).toBe(NEEDS_APPROVAL_RESULT);
  });

  it("positive control: a chat task's expired approval still re-queues the step", async () => {
    const { clock, engine, task } = await parked("chat");
    clock.advance(APPROVAL_TTL_MS + 1);
    await flush();
    expect((await engine.get(task.id))?.status).toBe("queued");
  });
});

describe("wake detector", () => {
  function clocks() {
    let wall = 1_000_000;
    let mono = 0;
    return {
      wallNow: () => wall,
      monotonicNow: () => mono,
      /** Time passing while the process runs. */
      run(ms: number) {
        wall += ms;
        mono += ms;
      },
      /** The Mac sleeps: the wall clock moves, the monotonic one does not. */
      sleep(ms: number) {
        wall += ms;
      },
    };
  }

  it("fires on a sleep (wall clock ahead of the monotonic one) and not on a quiet interval", () => {
    vi.useFakeTimers();
    try {
      const c = clocks();
      const onWake = vi.fn();
      const d = createWakeDetector({
        onWake,
        wallNow: c.wallNow,
        monotonicNow: c.monotonicNow,
        intervalMs: 20_000,
      });
      d.start();
      c.run(20_000);
      vi.advanceTimersByTime(20_000);
      expect(onWake).not.toHaveBeenCalled();
      c.sleep(8 * 3_600_000);
      c.run(20_000);
      vi.advanceTimersByTime(20_000);
      expect(onWake).toHaveBeenCalledTimes(1);
      expect(onWake.mock.calls[0]?.[0]).toBeGreaterThan(7 * 3_600_000);
      // The next interval is quiet again.
      c.run(20_000);
      vi.advanceTimersByTime(20_000);
      expect(onWake).toHaveBeenCalledTimes(1);
      d.stop();
      c.sleep(3_600_000);
      vi.advanceTimersByTime(60_000);
      expect(onWake).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a small drift under the threshold is ignored; a rejected handler goes to onError", async () => {
    const c = clocks();
    const onError = vi.fn();
    const d = createWakeDetector({
      onWake: async () => {
        throw new Error("boom");
      },
      onError,
      wallNow: c.wallNow,
      monotonicNow: c.monotonicNow,
      thresholdMs: 30_000,
    });
    c.sleep(10_000);
    d.check();
    await flush();
    expect(onError).not.toHaveBeenCalled();
    c.sleep(60_000);
    d.check();
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
