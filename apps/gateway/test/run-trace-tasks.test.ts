import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRun, createThread, getRun, listRunFrames, listRunSteps } from "@psyche/db";
import type { AgentEvent, Run, RunStep, Task, ToolCall } from "@psyche/protocol";
import type { TaskTurn } from "@psyche/tasks";
import { afterEach, describe, expect, it } from "vitest";
import { runRecordingsDir, runRetention } from "../src/retention.ts";
import { taskRunTrace } from "../src/run-trace/tasks.ts";
import { adminClient, ik, startTestGateway, type TestClient, type TestGateway } from "./helpers.ts";

/**
 * Run trace T1, part 3 (docs/design/run-trace-2026.md §4.2): task, automation and specialist
 * turns through the same sink; specialist spawn steps; memory writes and screenshots as frames.
 */

let t: TestGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.cleanup();
  t = null;
});

const NOW = Date.parse("2026-10-26T10:00:00.000Z");

async function setup() {
  const clock = { now: NOW };
  t = await startTestGateway({ now: () => new Date(clock.now) });
  const gw = t.gateway;
  const owner = await adminClient(gw);
  clients.push(owner);
  const thread = createThread(gw.context.db, {
    kind: "main",
    sessionKey: "owner:main",
    title: "Main",
  });
  const trace = taskRunTrace({
    db: gw.context.db,
    sink: () => gw.context.runTrace,
    publish: (event, payload, threadId) => gw.bus.publish(event, payload, threadId),
    modelRef: "anthropic/claude-opus-5-5",
    onError: (err) => {
      throw err;
    },
  });
  return { gw, owner, thread, trace, clock };
}

function task(threadId: string, extra: Partial<Task> = {}): Task {
  return {
    id: "task_trace_1",
    threadId,
    title: "Find a dentist",
    goal: "Find a dentist",
    status: "running",
    createdFrom: "chat",
    ...extra,
  } as Task;
}

const ev = (runId: string, e: Record<string, unknown>) => ({ ...e, runId }) as AgentEvent;

describe("task runs in the run trace", () => {
  it("records a task turn as its own run, with tool calls, steps and their link", async () => {
    const { gw, owner, thread, trace } = await setup();
    const turn: TaskTurn = {
      taskId: "task_trace_1",
      runId: gw.context.db.newId(),
      task: task(thread.id),
    };
    trace.start(turn);
    trace.event(
      turn,
      ev(turn.runId, {
        type: "tool_call",
        toolCallId: "tc_1",
        tool: "web.search",
        status: "running",
        level1: "Searching dentists",
      }),
    );
    trace.event(
      turn,
      ev(turn.runId, {
        type: "tool_call",
        toolCallId: "tc_1",
        tool: "web.search",
        status: "ok",
        level1: "Searching dentists",
      }),
    );
    trace.event(
      turn,
      ev(turn.runId, {
        type: "usage",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.001 },
      }),
    );
    trace.end(turn, "final");

    const run = getRun(gw.context.db, turn.runId) as Run;
    expect(run).toMatchObject({
      kind: "task",
      origin: "owner",
      taskId: "task_trace_1",
      status: "done",
      title: "Find a dentist",
    });
    const steps = listRunSteps(gw.context.db, turn.runId);
    expect(steps.map((s) => [s.kind, s.status])).toEqual([
      ["tool", "ok"],
      ["model", "ok"],
    ]);
    const event = await owner.waitForEvent(
      (e) =>
        e.event === "tool_call.updated" &&
        (e.payload as { toolCall: ToolCall }).toolCall.status === "ok",
    );
    expect((event.payload as { toolCall: ToolCall }).toolCall.stepId).toBe(steps[0]?.id);
    const list = await owner.call<{ runs: Run[] }>("runs.list", { taskId: "task_trace_1" });
    expect(list.runs.map((r) => r.id)).toEqual([turn.runId]);
    // Ends map: an approval park keeps the run awaiting; a stop is cancelled.
    const parked: TaskTurn = { ...turn, runId: gw.context.db.newId() };
    trace.start(parked);
    trace.end(parked, "awaiting_approval");
    expect(getRun(gw.context.db, parked.runId)?.status).toBe("awaiting_approval");
  });

  it("links an automation's run both ways, with its usage", async () => {
    const { gw, thread, trace } = await setup();
    const db = gw.context.db;
    const at = new Date(NOW).toISOString();
    db.sqlite
      .prepare(
        "INSERT INTO automations (id, kind, title, schedule, timezone, prompt, created_at, updated_at) VALUES ('auto_1', 'cron', 'Brief', '0 7 * * *', 'UTC', 'brief', ?, ?)",
      )
      .run(at, at);
    db.sqlite
      .prepare(
        "INSERT INTO automation_runs (id, automation_id, task_id, trigger, scheduled_for, started_at, created_at) VALUES ('ar_1', 'auto_1', 'task_auto', 'schedule', ?, ?, ?)",
      )
      .run(at, at, at);
    const turn: TaskTurn = {
      taskId: "task_auto",
      runId: db.newId(),
      task: task(thread.id, { id: "task_auto", createdFrom: "automation" }),
    };
    trace.start(turn);
    trace.event(
      turn,
      ev(turn.runId, {
        type: "usage",
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.01 },
      }),
    );
    trace.end(turn, "final");
    expect(getRun(db, turn.runId)).toMatchObject({
      kind: "automation",
      origin: "automation",
      automationRunId: "ar_1",
    });
    const row = db.sqlite
      .prepare("SELECT run_id, usage FROM automation_runs WHERE id = 'ar_1'")
      .get() as {
      run_id: string;
      usage: string;
    };
    expect(row.run_id).toBe(turn.runId);
    expect(JSON.parse(row.usage)).toMatchObject({ input: 100, output: 20 });
  });

  it("makes a specialist's turn a child run, linked from its spawn step", async () => {
    const { gw, thread, trace } = await setup();
    const db = gw.context.db;
    const sink = gw.context.runTrace;
    const parent = createRun(db, {
      threadId: thread.id,
      modelRef: "anthropic/claude-opus-5-5",
      kind: "chat",
    });
    // The parent spawns: its spawn call returns at once; `subagent` events carry the job.
    sink.apply(
      parent.id,
      thread.id,
      ev(parent.id, {
        type: "tool_call",
        toolCallId: "tc_spawn",
        tool: "specialist.spawn",
        status: "running",
        level1: "Starting research",
      }),
    );
    sink.apply(
      parent.id,
      thread.id,
      ev(parent.id, {
        type: "subagent",
        messageId: "m1",
        toolCallId: "tc_spawn",
        taskId: "task_spec",
        childRunId: null,
        status: "queued",
        label: "Research · Flights",
      }),
    );
    sink.apply(
      parent.id,
      thread.id,
      ev(parent.id, {
        type: "tool_call",
        toolCallId: "tc_spawn",
        tool: "specialist.spawn",
        status: "ok",
        level1: "Starting research",
      }),
    );
    sink.end(parent.id, "final");
    let spawn = listRunSteps(db, parent.id)[0] as RunStep;
    expect(spawn).toMatchObject({ kind: "subagent", taskId: "task_spec", status: "running" });

    const turn: TaskTurn = {
      taskId: "task_spec",
      runId: db.newId(),
      task: task(thread.id, {
        id: "task_spec",
        createdFrom: "subagent",
        specialist: {
          role: "research",
          parentRunId: parent.id,
          parentThreadId: thread.id,
          rootRunId: null,
          budget: { limit: { tokens: 100_000 }, used: { steps: 0, tokens: 0, wallMs: 0 } },
          deadline: null,
        } as unknown as NonNullable<Task["specialist"]>,
      }),
    };
    trace.start(turn);
    trace.end(turn, "final");
    expect(getRun(db, turn.runId)).toMatchObject({
      kind: "task",
      origin: "subagent",
      parentRunId: parent.id,
      rootRunId: parent.id,
      specialist: { role: "research" },
    });
    spawn = listRunSteps(db, parent.id)[0] as RunStep;
    expect(spawn).toMatchObject({ childRunId: turn.runId, status: "ok" });
  });
});

describe("memory writes and frames on their step", () => {
  it("links a memory write to its step even when it lands before the call's event", async () => {
    const { gw, thread } = await setup();
    const sink = gw.context.runTrace;
    const run = createRun(gw.context.db, {
      threadId: thread.id,
      modelRef: "anthropic/claude-opus-5-5",
    });
    const early = sink.memoryChanged(run.id, "tc_mem", "notes/dentist.md");
    sink.apply(
      run.id,
      thread.id,
      ev(run.id, {
        type: "tool_call",
        toolCallId: "tc_mem",
        tool: "memory",
        status: "running",
        level1: "Writing a note",
      }),
    );
    const step = listRunSteps(gw.context.db, run.id)[0] as RunStep;
    expect(step.id).toBe(early);
    expect(step.memoryPath).toBe("notes/dentist.md");
    // Once the step is known, a later write reuses it.
    expect(sink.memoryChanged(run.id, "tc_mem", "notes/b.md")).toBe(step.id);
  });

  it("keeps screenshots as run frames on the call's step, expiring with replay retention", async () => {
    const { gw, owner, thread, clock } = await setup();
    const sink = gw.context.runTrace;
    const db = gw.context.db;
    const run = createRun(db, { threadId: thread.id, modelRef: "anthropic/claude-opus-5-5" });
    sink.apply(
      run.id,
      thread.id,
      ev(run.id, {
        type: "tool_call",
        toolCallId: "tc_shot",
        tool: "computer.screenshot",
        status: "running",
        level1: "Looking at Notes",
      }),
    );
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    expect(
      sink.addFrame(run.id, "tc_shot", {
        data: jpeg,
        mime: "image/jpeg",
        width: 1372,
        height: 887,
      }),
    ).toBe(1);
    expect(
      sink.addFrame(run.id, "tc_shot", {
        data: jpeg,
        mime: "image/jpeg",
        width: 1372,
        height: 887,
      }),
    ).toBe(2);
    const step = listRunSteps(db, run.id)[0] as RunStep;
    expect(step.frames).toEqual({ first: 1, last: 2 });
    const frames = await owner.call<{ frames: { seq: number; stepId: string }[] }>("runs.frames", {
      runId: run.id,
    });
    expect(frames.frames.map((f) => [f.seq, f.stepId])).toEqual([
      [1, step.id],
      [2, step.id],
    ]);
    const img = await owner.call<{ mime: string; dataBase64: string }>("runs.frame", {
      runId: run.id,
      seq: 1,
      size: "full",
    });
    expect(Buffer.from(img.dataBase64, "base64")).toEqual(Buffer.from(jpeg));
    const path = listRunFrames(db, run.id)[0]?.path as string;
    const file = join(runRecordingsDir(gw.context.config.home, run.id), path);
    expect(existsSync(file)).toBe(true);
    // Past data.replayRetentionDays (default 7) the image goes and the row says so.
    clock.now += 8 * 86_400_000;
    expect(runRetention(gw.context).frames).toBe(2);
    expect(existsSync(file)).toBe(false);
    expect(listRunFrames(db, run.id)[0]).toMatchObject({ expired: true });
    // Off keeps none.
    await owner.call("settings.set", { key: "data.replayRetentionDays", value: 0 }, ik());
    expect(
      sink.addFrame(run.id, "tc_shot", { data: jpeg, mime: "image/jpeg", width: 10, height: 10 }),
    ).toBeUndefined();
  });
});
