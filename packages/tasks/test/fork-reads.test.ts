import type { Staging, StagingReads } from "@psyche/protocol";
import { FakeClock, FakeNotifier, FakePermissionBroker } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { TaskWorkerPool } from "../src/index.ts";
import { THREAD, testEngine } from "./helpers.ts";
import { ControlledLoop, clockTimers } from "./loops.ts";

/**
 * Fork a plan F2 (fork-a-plan-2026.md §3.2, §6): the worker hands a branch's task the read guard
 * that holds `web.fetch` to the branch's own search results, and cancelling a branch's task
 * revokes the run's authority at once.
 */

const FORK: Staging = { kind: "fork", forkId: "fork_1", branchId: "br_1" };
const base = {
  threadId: THREAD,
  title: "Plan: Move",
  goal: "Work out the plan",
  createdFrom: "fork" as const,
  mode: "unattended" as const,
  staging: FORK,
};

const guard: StagingReads = { allowFetch: () => false, observe: () => undefined };
const sink = { stage: async () => ({ staged: false as const }) };

function setup(reads?: (s: Staging) => StagingReads | undefined) {
  const clock = new FakeClock();
  const { engine } = testEngine({ clock });
  const loop = new ControlledLoop();
  const broker = new FakePermissionBroker({ clock });
  const revoked: string[] = [];
  const revoke = broker.revokeRunAuthority.bind(broker);
  broker.revokeRunAuthority = async (runId: string) => {
    revoked.push(runId);
    await revoke(runId);
  };
  const pool = new TaskWorkerPool({
    engine,
    loop,
    clock,
    timers: clockTimers(clock),
    broker,
    notifier: new FakeNotifier({ clock }),
    owner: "fork",
    newRunId: () => "run_1",
    stagingSinkFor: () => sink,
    stagingToolsFor: () => (tool) => tool === "fork_report",
    ...(reads === undefined ? {} : { stagingReadsFor: (s: Staging) => reads(s) }),
    claim: { origins: ["fork"] },
  });
  return { engine, loop, pool, revoked };
}

describe("worker: a fork task's read guard", () => {
  it("hands the loop the guard beside the sink and the toolset", async () => {
    const { engine, loop, pool } = setup(() => guard);
    await engine.create(base);
    const next = loop.nextTurn();
    const report = pool.runOnce();
    const turn = await next;
    const staging = turn.input.staging;
    expect(staging?.staging).toEqual(FORK);
    expect(staging?.reads).toBe(guard);
    expect(staging?.sink).toBe(sink);
    expect(staging?.toolAllowed?.("fork_report")).toBe(true);
    expect(staging?.toolAllowed?.("web.fetch")).toBe(false);
    turn.end("final");
    await report;
  });

  it("without a provider (or when it declines) the run carries no guard, so it cannot fetch", async () => {
    for (const reads of [undefined, () => undefined]) {
      const { engine, loop, pool } = setup(reads);
      await engine.create(base);
      const next = loop.nextTurn();
      const report = pool.runOnce();
      const turn = await next;
      expect(turn.input.staging).toBeDefined();
      expect(turn.input.staging?.reads).toBeUndefined();
      turn.end("final");
      await report;
    }
  });
});

describe("worker: cancel revokes a fork task's authority", () => {
  it("aborts the turn, tells the loop and revokes the run at once", async () => {
    const { engine, loop, pool, revoked } = setup(() => guard);
    const task = await engine.create(base);
    const next = loop.nextTurn();
    const report = pool.runOnce();
    const turn = await next;
    await engine.cancel(task.id, "cancelled");
    expect(turn.input.signal?.aborted).toBe(true);
    expect(loop.cancelled).toEqual([turn.runId]);
    expect(revoked).toEqual([turn.runId]);
    const r = await report;
    expect(r?.task?.status).toBe("cancelled");
  });

  it("control: a fork task that ends normally revokes nothing", async () => {
    const { engine, loop, pool, revoked } = setup(() => guard);
    await engine.create(base);
    const next = loop.nextTurn();
    const report = pool.runOnce();
    const turn = await next;
    turn.end("final");
    await report;
    expect(revoked).toEqual([]);
  });
});
