import { Task, TaskAction, validateEventPayload, validateResult } from "@psyche/protocol";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  createTaskHandlers,
  LEVEL1_MAX,
  type Level3Store,
  type TaskEngineEvent,
} from "../src/index.ts";
import { THREAD, testEngine } from "./helpers.ts";

const INPUT = {
  threadId: THREAD,
  title: "Reply to Alice",
  goal: "Reply to Alice's permission slip email",
  createdFrom: "chat" as const,
};

describe("Activity log levels", () => {
  it("stores a level-1 line, a level-2 action and a level-3 ref", async () => {
    const stored: unknown[] = [];
    const level3: Level3Store = {
      put: (_taskId, payload) => {
        stored.push(payload);
        return `lib_${stored.length}`;
      },
    };
    const { engine } = testEngine({ level3 });
    const task = await engine.create(INPUT);
    const a = await engine.addAction(task.id, {
      toolCallId: "tc_1",
      level1: "Reading Gmail thread\nfrom Alice   ",
      level2: { tool: "gmail.read", target: "thread:123", outcome: "ok" },
      level3: { request: { id: "123" }, response: { messages: 3 } },
    });
    expect(a.level1).toBe("Reading Gmail thread from Alice");
    expect(a.level2).toEqual({ tool: "gmail.read", target: "thread:123", outcome: "ok" });
    expect(a.level3Ref).toBe("lib_1");
    expect(stored).toEqual([{ request: { id: "123" }, response: { messages: 3 } }]);
    expect(Value.Check(TaskAction, a)).toBe(true);
  });

  it("caps level 1 to one short line and requires a level-2 tool", async () => {
    const { engine } = testEngine();
    const task = await engine.create(INPUT);
    const a = await engine.addAction(task.id, { level1: "x".repeat(500), level2: { tool: "t" } });
    expect(a.level1).toHaveLength(LEVEL1_MAX);
    expect(a.level1.endsWith("…")).toBe(true);
    await expect(
      engine.addAction(task.id, { level1: "y", level2: { tool: "" } }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      engine.addAction(task.id, { level1: "z", level2: { tool: "t" }, level3: { a: 1 } }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("tasks.actions pages levels 1–2 with the level-3 ref only", async () => {
    const { engine } = testEngine();
    const task = await engine.create(INPUT);
    for (let i = 0; i < 5; i += 1) {
      await engine.addAction(task.id, {
        level1: `step ${i}`,
        level2: { tool: "search" },
        level3Ref: `lib_${i}`,
      });
    }
    const h = createTaskHandlers({ engine });
    const p1 = await h["tasks.actions"]({ taskId: task.id, limit: 2 });
    expect(p1.actions.map((a) => a.idx)).toEqual([0, 1]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await h["tasks.actions"]({
      taskId: task.id,
      limit: 10,
      cursor: p1.nextCursor ?? "",
    });
    expect(p2.actions.map((a) => a.level1)).toEqual(["step 2", "step 3", "step 4"]);
    expect(p2.nextCursor).toBeNull();
    expect(p2.actions[0]?.level3Ref).toBe("lib_2");
    validateResult("tasks.actions", p2);
  });
});

describe("events", () => {
  it("emits task.updated and task.action with increasing stateVersion and valid payloads", async () => {
    let v = 100;
    const { engine } = testEngine({ nextStateVersion: () => ++v });
    const events: TaskEngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    const task = await engine.create(INPUT);
    await engine.addAction(task.id, { level1: "hi", level2: { tool: "t" } });
    await engine.claim("w", { leaseMs: 1000 });
    expect(events.map((e) => e.event)).toEqual(["task.updated", "task.action", "task.updated"]);
    expect(events.map((e) => e.stateVersion)).toEqual([101, 102, 103]);
    for (const e of events) validateEventPayload(e.event, e.payload);
  });

  it("a throwing listener does not undo the mutation", async () => {
    const { engine } = testEngine();
    engine.subscribe(() => {
      throw new Error("boom");
    });
    const task = await engine.create(INPUT);
    expect((await engine.get(task.id))?.status).toBe("queued");
  });
});

describe("engine extensions", () => {
  it("returns protocol-valid tasks and keeps run mode and budget on the record", async () => {
    const { engine } = testEngine();
    const task = await engine.create({
      ...INPUT,
      mode: "unattended",
      budget: { maxSteps: 5 },
      taint: true,
      plan: { approvedAt: null, steps: [{ id: "s1", title: "Read", status: "pending" }] },
    });
    expect(Value.Check(Task, task)).toBe(true);
    expect(task.taint).toBe(true);
    const rec = engine.getRecord(task.id);
    expect(rec?.runMode).toBe("unattended");
    expect(rec?.budget).toEqual({ maxSteps: 5 });
  });

  it("retry from a step resets later steps but never an uncertain one", async () => {
    const { engine, clock } = testEngine();
    const task = await engine.create(INPUT);
    await engine.claim("w", { leaseMs: 1000 });
    await engine.checkpoint(task.id, { stepId: "a", replaySafe: true, status: "done" });
    await engine.checkpoint(task.id, { stepId: "b", replaySafe: false, status: "running" });
    clock.advance(1001);
    await engine.recoverExpired();
    await engine.claim("w", { leaseMs: 1000 });
    await engine.checkpoint(task.id, { stepId: "c", replaySafe: true, status: "failed" });
    await engine.updateStatus(task.id, "failed");
    await engine.retry(task.id, { fromStepId: "a" });
    const cps = await engine.checkpoints(task.id);
    expect(cps.map((c) => [c.stepId, c.status])).toEqual([
      ["a", "pending"],
      ["b", "uncertain"],
      ["c", "pending"],
    ]);
    expect(engine.getRecord(task.id)?.resume.at(-1)).toEqual({ kind: "retry", fromStepId: "a" });
  });

  it("resume returns a task paused while parked to the state it waits in", async () => {
    const { engine } = testEngine();
    const task = await engine.create(INPUT);
    await engine.requestInput(task.id, [
      {
        question: "Q?",
        header: "Q",
        options: [{ label: "a" }, { label: "b" }],
        multiSelect: false,
      },
    ]);
    await engine.pause(task.id);
    expect((await engine.resume(task.id)).status).toBe("awaiting_input");
  });

  it("rejects invalid questions", async () => {
    const { engine } = testEngine();
    const task = await engine.create(INPUT);
    await expect(
      engine.requestInput(task.id, [
        { question: "Q?", header: "far too long header", options: [], multiSelect: false },
      ]),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("attaches its browser session and sandbox", async () => {
    const { engine } = testEngine();
    const task = await engine.create(INPUT);
    const t = await engine.attachResources(task.id, {
      browserSessionId: "bs_1",
      sandboxId: "sb_1",
    });
    expect([t.browserSessionId, t.sandboxId]).toEqual(["bs_1", "sb_1"]);
  });

  it("tasks.list pages most recently updated first; handlers validate against the schemas", async () => {
    const { engine, clock } = testEngine();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push((await engine.create(INPUT)).id);
      clock.advance(10);
    }
    const h = createTaskHandlers({ engine });
    const page = await h["tasks.list"]({ limit: 2 });
    expect(page.tasks.map((t) => t.id)).toEqual([ids[2], ids[1]]);
    validateResult("tasks.list", page);
    const cancelled = await h["tasks.cancel"]({ taskId: ids[0] as string });
    expect(cancelled.task.status).toBe("cancelled");
    const retried = await h["tasks.retry"]({ taskId: ids[0] as string });
    expect(retried.task.status).toBe("queued");
    validateResult("tasks.retry", retried);
    await expect(h["tasks.get"]({ taskId: "missing" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
