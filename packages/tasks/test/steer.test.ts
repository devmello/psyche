import { FakeClock, FakeNotifier, FakePermissionBroker } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { createTaskHandlers, TaskWorkerPool } from "../src/index.ts";
import { THREAD, testEngine } from "./helpers.ts";
import { ControlledLoop, clockTimers } from "./loops.ts";

function setup() {
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
    newRunId: () => "run_1",
  });
  const h = createTaskHandlers({ engine, pools: [pool] });
  return { engine, loop, pool, h };
}

const newTask = (engine: ReturnType<typeof setup>["engine"]) =>
  engine.create({
    threadId: THREAD,
    title: "Compare",
    goal: "Compare three laptops",
    createdFrom: "chat",
  });

describe("tasks.steer (specialists §4.7)", () => {
  it("hands the text to the running turn", async () => {
    const { engine, loop, pool, h } = setup();
    const task = await newTask(engine);
    const next = loop.nextTurn();
    const report = pool.runOnce();
    const turn = await next;
    const res = await h["tasks.steer"]({ taskId: task.id, text: "Only under $1,000" });
    expect(loop.steered).toEqual([{ runId: turn.runId, text: "Only under $1,000" }]);
    expect(engine.getRecord(task.id)?.resume).toEqual([]);
    expect(res.task.status).toBe("running");
    const lines = await engine.actions(task.id);
    expect(lines.at(-1)).toMatchObject({
      level1: "You steered it: Only under $1,000",
      level2: { tool: "task.steer", outcome: "delivered" },
    });
    turn.end("final");
    await report;
  });

  it("queues the text for the next turn when none is running", async () => {
    const { engine, loop, pool, h } = setup();
    const task = await newTask(engine);
    await engine.pause(task.id);
    await h["tasks.steer"]({ taskId: task.id, text: "Skip refurbished ones" });
    expect(loop.steered).toEqual([]);
    expect(engine.getRecord(task.id)?.resume).toEqual([
      { kind: "steered", text: "Skip refurbished ones" },
    ]);
    await h["tasks.resume"]({ taskId: task.id });
    const next = loop.nextTurn();
    const report = pool.runOnce();
    const turn = await next;
    expect(turn.input.input.text).toContain("New guidance from the owner: Skip refurbished ones");
    turn.end("final");
    await report;
  });

  it("refuses a finished task", async () => {
    const { engine, h } = setup();
    const task = await newTask(engine);
    await engine.cancel(task.id);
    await expect(h["tasks.steer"]({ taskId: task.id, text: "go on" })).rejects.toMatchObject({
      code: "conflict",
    });
  });
});
