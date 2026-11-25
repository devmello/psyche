import type { Staging } from "@psyche/protocol";
import { FakeClock, FakeNotifier, FakePermissionBroker } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { TaskWorkerPool } from "../src/index.ts";
import { THREAD, testDb, testEngine, tmpDir } from "./helpers.ts";
import { ControlledLoop, clockTimers } from "./loops.ts";

/**
 * Fork a plan F1 (docs/design/fork-a-plan-2026.md §2.2, §3.1): a branch's task is created with
 * `createdFrom: "fork"` and a `fork` staging block, both set by the server. The chat pool never
 * claims it, and a fork task without its block cannot exist.
 */

const NIGHT: Staging = { kind: "night", nightId: "night_1" };
const FORK: Staging = { kind: "fork", forkId: "fork_1", branchId: "br_1" };
const base = { threadId: THREAD, title: "Branch", goal: "Work out the plan" };

describe("tasks: the fork origin", () => {
  it("round-trips a fork task through real SQLite, on a fresh engine", async () => {
    const t = tmpDir();
    try {
      const clock = new FakeClock();
      const first = testEngine({ clock, db: testDb(clock, t.file) });
      const task = await first.engine.create({
        ...base,
        createdFrom: "fork",
        mode: "unattended",
        staging: FORK,
      });
      expect(task.createdFrom).toBe("fork");
      first.db.sqlite.close();
      const second = testEngine({ clock, db: testDb(clock, t.file) });
      const record = second.engine.getRecord(task.id);
      expect(record?.staging).toEqual(FORK);
      expect(record?.task.createdFrom).toBe("fork");
      second.db.sqlite.close();
    } finally {
      t.cleanup();
    }
  });

  it.each([
    ["no staging block", {}],
    ["a night block", { staging: NIGHT }],
  ])("refuses a fork task with %s", async (_label, extra) => {
    const { engine } = testEngine();
    await expect(
      engine.create({ ...base, createdFrom: "fork", mode: "unattended", ...extra }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    expect(await engine.list()).toHaveLength(0);
  });

  it("refuses an attended fork task", async () => {
    const { engine } = testEngine();
    await expect(
      engine.create({ ...base, createdFrom: "fork", staging: FORK }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it.each(["chat", "automation", "subagent"] as const)(
    "refuses a fork block under the %s origin",
    async (createdFrom) => {
      const { engine } = testEngine();
      await expect(
        engine.create({ ...base, createdFrom, mode: "unattended", staging: FORK }),
      ).rejects.toMatchObject({ code: "invalid_params" });
      expect(await engine.list()).toHaveLength(0);
    },
  );

  it("control: a night block under a non-fork origin is still accepted (night rows unchanged)", async () => {
    const { engine } = testEngine();
    const task = await engine.create({
      ...base,
      createdFrom: "chat",
      mode: "unattended",
      staging: NIGHT,
    });
    expect(engine.getRecord(task.id)?.staging).toEqual(NIGHT);
  });

  it("the chat pool's claim filter skips fork tasks and a fork claim finds them", async () => {
    const { engine } = testEngine();
    const fork = await engine.create({
      ...base,
      createdFrom: "fork",
      mode: "unattended",
      staging: FORK,
    });
    const chat = await engine.create({ ...base, createdFrom: "chat" });
    const claimed = await engine.claim("chat/0", {
      leaseMs: 60_000,
      excludeOrigins: ["subagent", "fork"],
    });
    expect(claimed?.taskId).toBe(chat.id);
    expect(
      await engine.claim("chat/1", { leaseMs: 60_000, excludeOrigins: ["subagent", "fork"] }),
    ).toBeUndefined();
    const forkClaim = await engine.claim("fork/0", { leaseMs: 60_000, origins: ["fork"] });
    expect(forkClaim?.taskId).toBe(fork.id);
  });
});

describe("worker: a fork task ends quietly", () => {
  async function finish(createdFrom: "fork" | "chat") {
    const clock = new FakeClock();
    const { engine } = testEngine({ clock });
    const loop = new ControlledLoop();
    const notifier = new FakeNotifier({ clock });
    const pool = new TaskWorkerPool({
      engine,
      loop,
      clock,
      timers: clockTimers(clock),
      broker: new FakePermissionBroker({ clock }),
      notifier,
      owner: "w1",
      newRunId: () => "run_1",
      stagingSinkFor: () => ({ stage: async () => ({ staged: false as const }) }),
    });
    await engine.create(
      createdFrom === "fork"
        ? { ...base, createdFrom, mode: "unattended", staging: FORK }
        : { ...base, createdFrom, mode: "unattended" },
    );
    const next = loop.nextTurn();
    const report = pool.runOnce();
    const turn = await next;
    turn.emit({ type: "chat.delta", messageId: "m1", delta: "Done." });
    turn.end("final");
    await report;
    return (await notifier.list()).map((n) => n.kind);
  }

  it("a branch posts no task_done, and the same task under the chat origin does (control)", async () => {
    expect(await finish("chat")).toEqual(["task_done"]);
    expect(await finish("fork")).toEqual([]);
  });
});
