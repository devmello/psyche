import { Methods, type Staging, Task as TaskSchema } from "@psyche/protocol";
import { FakeClock, FakeNotifier, FakePermissionBroker } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { createTaskHandlers, TaskWorkerPool } from "../src/index.ts";
import { THREAD, testDb, testEngine, tmpDir } from "./helpers.ts";
import { ControlledLoop, clockTimers } from "./loops.ts";

/**
 * Night shift W1 (docs/design/night-shift-2026.md §2.2): the task's `staging` block is set by the
 * server only, stored, read back whole, never on the wire, and a staging task never runs without a
 * sink.
 */

const NIGHT: Staging = { kind: "night", nightId: "night_1" };
const FORK: Staging = { kind: "fork", forkId: "fork_1", branchId: "br_1" };
const base = {
  threadId: THREAD,
  title: "Prepare",
  goal: "Prepare tomorrow",
  createdFrom: "chat" as const,
};

describe("tasks: the server-only staging field", () => {
  it.each([NIGHT, FORK])(
    "round-trips %j through real SQLite, on a fresh engine",
    async (staging) => {
      const t = tmpDir();
      try {
        const clock = new FakeClock();
        const first = testEngine({ clock, db: testDb(clock, t.file) });
        // A fork block goes with the fork origin, and only with it (fork-a-plan F1).
        const origin = staging.kind === "fork" ? { createdFrom: "fork" as const } : {};
        const task = await first.engine.create({
          ...base,
          ...origin,
          mode: "unattended",
          staging,
        });
        first.db.sqlite.close();
        const second = testEngine({ clock, db: testDb(clock, t.file) });
        expect(second.engine.getRecord(task.id)?.staging).toEqual(staging);
        second.db.sqlite.close();
      } finally {
        t.cleanup();
      }
    },
  );

  it("is null for an ordinary task (positive control for the rows above)", async () => {
    const { engine } = testEngine();
    const task = await engine.create(base);
    expect(engine.getRecord(task.id)?.staging).toBeNull();
  });

  it("is never on the wire Task", async () => {
    const { engine } = testEngine();
    const task = await engine.create({ ...base, mode: "unattended", staging: NIGHT });
    expect(JSON.stringify(task)).not.toContain("staging");
    expect(JSON.stringify(await engine.get(task.id))).not.toContain("staging");
    expect(JSON.stringify(TaskSchema)).not.toContain("staging");
  });

  it.each([
    ["an unknown kind", { kind: "weekend", nightId: "n" }],
    ["an extra key", { kind: "night", nightId: "n", extra: 1 }],
    ["an empty id", { kind: "night", nightId: "" }],
    ["a missing id", { kind: "night" }],
    ["a fork without its branch", { kind: "fork", forkId: "f" }],
    ["a number", 7],
    ["a string", "night"],
  ])("refuses %s", async (_label, staging) => {
    const { engine } = testEngine();
    await expect(
      engine.create({ ...base, mode: "unattended", staging: staging as unknown as Staging }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("refuses an attended staging task", async () => {
    const { engine } = testEngine();
    await expect(engine.create({ ...base, staging: NIGHT })).rejects.toMatchObject({
      code: "invalid_params",
    });
    await expect(
      engine.create({ ...base, mode: "attended", staging: NIGHT }),
    ).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("a stored block that cannot be read fails closed", async () => {
    const { engine, db } = testEngine();
    const task = await engine.create({ ...base, mode: "unattended", staging: NIGHT });
    db.sqlite.prepare("UPDATE tasks SET staging = ? WHERE id = ?").run('{"kind":"x"}', task.id);
    expect(() => engine.getRecord(task.id)).toThrow();
  });

  it("no client method creates a task or carries staging", () => {
    const names = Object.keys(Methods).filter((m) => m.startsWith("tasks."));
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain("tasks.create");
    for (const [name, def] of Object.entries(Methods)) {
      expect(JSON.stringify(def.params), name).not.toContain('"staging"');
      expect(JSON.stringify(def.result), name).not.toContain('"staging"');
    }
    const { engine } = testEngine();
    expect(
      Object.keys(createTaskHandlers({ engine })).filter((m) => m.endsWith(".create")),
    ).toEqual([]);
  });

  it("a client's tasks.* call with a staging param changes nothing", async () => {
    const { engine } = testEngine();
    const task = await engine.create(base);
    const h = createTaskHandlers({ engine });
    const extra = { staging: NIGHT } as unknown as Record<string, never>;
    await h["tasks.get"]({ taskId: task.id, ...extra });
    await h["tasks.pause"]({ taskId: task.id, ...extra });
    await h["tasks.resume"]({ taskId: task.id, ...extra });
    expect(engine.getRecord(task.id)?.staging).toBeNull();
  });
});

describe("worker: a staging task", () => {
  function setup(
    stagingSinkFor?: ConstructorParameters<typeof TaskWorkerPool>[0]["stagingSinkFor"],
  ) {
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
      ...(stagingSinkFor === undefined ? {} : { stagingSinkFor }),
    });
    return { engine, loop, pool };
  }

  it("hands the loop its staging block and the sink", async () => {
    const sink = { stage: async () => ({ staged: false as const }) };
    const seen: Staging[] = [];
    const { engine, loop, pool } = setup((s) => {
      seen.push(s);
      return sink;
    });
    await engine.create({ ...base, mode: "unattended", staging: NIGHT });
    const next = loop.nextTurn();
    const report = pool.runOnce();
    const turn = await next;
    expect(turn.input.staging).toEqual({ staging: NIGHT, sink });
    expect(turn.input.mode).toBe("unattended");
    expect(seen).toEqual([NIGHT]);
    turn.end("final");
    await report;
  });

  it("does not run at all when nothing can record its writes", async () => {
    const { engine, loop, pool } = setup();
    const task = await engine.create({ ...base, mode: "unattended", staging: NIGHT });
    const r = await pool.runOnce();
    expect(loop.turns).toHaveLength(0);
    expect(r?.outcome).toBe("failed");
    expect((await engine.get(task.id))?.status).toBe("failed");
  });

  it("does not run when the sink provider declines the block", async () => {
    const { engine, loop, pool } = setup(() => undefined);
    await engine.create({ ...base, createdFrom: "fork", mode: "unattended", staging: FORK });
    await pool.runOnce();
    expect(loop.turns).toHaveLength(0);
  });

  it("an ordinary task carries no staging (positive control)", async () => {
    const { engine, loop, pool } = setup(() => {
      throw new Error("not asked for an ordinary task");
    });
    await engine.create(base);
    const next = loop.nextTurn();
    const report = pool.runOnce();
    const turn = await next;
    expect(turn.input.staging).toBeUndefined();
    turn.end("final");
    await report;
  });
});
