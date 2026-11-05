import { FakeClock, FakeNotifier, FakePermissionBroker } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { TaskWorkerPool } from "../src/index.ts";
import { THREAD, testEngine } from "./helpers.ts";
import { ControlledLoop, clockTimers } from "./loops.ts";

/** `canClaim` keeps queued tasks queued while an app update is prepared; running turns go on. */

function setup(canClaim: () => boolean) {
  const clock = new FakeClock();
  const { engine } = testEngine({ clock });
  const loop = new ControlledLoop();
  const pool = new TaskWorkerPool({
    engine,
    loop,
    clock,
    timers: clockTimers(clock),
    broker: new FakePermissionBroker({ clock }),
    notifier: new FakeNotifier({ clock }),
    owner: "w1",
    isReplaySafe: () => false,
    canClaim,
  });
  return { engine, loop, pool };
}

describe("TaskWorkerPool canClaim", () => {
  it("claims nothing while it says no, and the task stays queued", async () => {
    let open = false;
    const { engine, loop, pool } = setup(() => open);
    const task = await engine.create({
      threadId: THREAD,
      title: "Water the plants",
      goal: "Water the plants",
      createdFrom: "chat",
    });
    expect(await pool.runOnce()).toBeUndefined();
    expect((await engine.get(task.id))?.status).toBe("queued");

    // The gate opened again: the same task is claimed and run.
    open = true;
    const next = loop.nextTurn();
    const report = pool.runOnce();
    (await next).end("final");
    expect((await report)?.task?.id).toBe(task.id);
    expect((await engine.get(task.id))?.status).toBe("done");
  });

  it("claims as before when it says yes", async () => {
    const { engine, loop, pool } = setup(() => true);
    await engine.create({
      threadId: THREAD,
      title: "Water the plants",
      goal: "Water the plants",
      createdFrom: "chat",
    });
    const next = loop.nextTurn();
    const report = pool.runOnce();
    const turn = await next;
    turn.end("final");
    expect((await report)?.task?.status).toBe("done");
  });
});
