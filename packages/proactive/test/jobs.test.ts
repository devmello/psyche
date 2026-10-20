import {
  createDbSessionResolver,
  createDeliverer,
  createTaskLauncher,
  SqliteScheduler,
} from "@psyche/scheduler";
import { SqliteTaskEngine, TaskWorkerPool } from "@psyche/tasks";
import { createIdGenerator, FakeAgentLoop, FakeClock, FakeNotifier } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  cadenceKind,
  HEARTBEAT_TASK_BUDGET,
  jobMarker,
  PROACTIVITY_BUDGET,
  type ProactiveJob,
  parseJobMarker,
  withProactiveJobs,
} from "../src/index.ts";
import { asleep, RecordingLauncher, T0, testDb } from "./helpers.ts";

const usage = (tokens: number) =>
  ({
    type: "usage",
    usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  }) as const;

/** The heartbeat on the real scheduler, task engine and worker pool with a scripted agent. */
function heartbeatRig(loop: FakeAgentLoop) {
  const clock = new FakeClock(T0);
  const db = testDb(clock);
  const notifier = new FakeNotifier({ clock });
  const engine = new SqliteTaskEngine({ db, clock });
  const pool = new TaskWorkerPool({ engine, loop, clock, notifier });
  const ids = createIdGenerator({ prefix: "s" });
  const scheduler = new SqliteScheduler({
    db,
    clock,
    timers: asleep,
    newId: () => ids.next(),
    launcher: withProactiveJobs(createTaskLauncher({ engine, pool }), {
      jobs: [],
      heartbeat: createTaskLauncher({ engine, pool, budget: HEARTBEAT_TASK_BUDGET }),
    }),
    sessions: createDbSessionResolver(db),
    notifier,
    deliverer: createDeliverer({ notifier }),
  });
  return { clock, db, notifier, engine, pool, scheduler };
}

describe("heartbeat budget (O2)", () => {
  it("runs the heartbeat as a task bounded to under 5k tokens, one proactive notification", async () => {
    const loop = FakeAgentLoop.script([
      [
        usage(1_200),
        { type: "chat.delta", messageId: "m1", delta: "Your 3pm moved to 4pm." },
        { type: "end", outcome: "final" },
      ],
    ]);
    const { scheduler, engine, pool, notifier } = heartbeatRig(loop);
    const hb = await scheduler.ensureHeartbeat({ timezone: "UTC" });
    const { taskId } = await scheduler.trigger(hb.id);
    const record = engine.getRecord(taskId ?? "");
    expect(record?.budget).toEqual(HEARTBEAT_TASK_BUDGET);
    expect(HEARTBEAT_TASK_BUDGET.maxTokens).toBeLessThanOrEqual(5_000);
    expect(record?.runMode).toBe("unattended");
    await pool.runOnce();
    await scheduler.idle();
    expect(loop.turns[0]?.mode).toBe("unattended");
    expect(scheduler.runs(hb.id).runs[0]?.status).toBe("done");
    const notifications = await notifier.list();
    expect(notifications.filter((n) => n.kind === "proactive")).toHaveLength(
      PROACTIVITY_BUDGET.heartbeat.notificationsPerRun,
    );
  });

  it("a heartbeat that overspends is stopped and reported once, not continued", async () => {
    const loop = FakeAgentLoop.script([
      [
        usage(6_000),
        { type: "chat.delta", messageId: "m1", delta: "still thinking…" },
        { type: "end", outcome: "final" },
      ],
    ]);
    const { scheduler, pool, notifier, engine } = heartbeatRig(loop);
    const hb = await scheduler.ensureHeartbeat({ timezone: "UTC" });
    const { taskId } = await scheduler.trigger(hb.id);
    await pool.runOnce();
    await scheduler.idle();
    const task = await engine.get(taskId ?? "");
    expect(task?.status).toBe("failed");
    expect(task?.summary).toContain("token budget (5000) exceeded");
    expect(scheduler.runs(hb.id).runs[0]?.status).toBe("failed");
    const kinds = (await notifier.list()).map((n) => n.kind);
    expect(kinds.filter((k) => k === "proactive")).toEqual([]);
    expect(kinds.filter((k) => k === "task_failed")).toHaveLength(1);
  });
});

describe("withProactiveJobs", () => {
  it("routes marked automations to their job, the rest to the agent launcher", async () => {
    const clock = new FakeClock(T0);
    const db = testDb(clock);
    const notifier = new FakeNotifier({ clock });
    const agent = new RecordingLauncher();
    const seen: string[] = [];
    const job: ProactiveJob = {
      name: "echo",
      matches: (a) => parseJobMarker(a.prompt)?.job === "echo",
      run: async (r) => {
        seen.push(parseJobMarker(r.automation.prompt)?.arg ?? "");
        return { status: "no_reply", summary: "echoed" };
      },
    };
    const failing: ProactiveJob = {
      name: "boom",
      matches: (a) => parseJobMarker(a.prompt)?.job === "boom",
      run: async () => {
        throw new Error("secret detail that must not reach the owner");
      },
    };
    const errors: unknown[] = [];
    const scheduler = new SqliteScheduler({
      db,
      clock,
      timers: asleep,
      launcher: withProactiveJobs(agent, { jobs: [job, failing], onError: (e) => errors.push(e) }),
      sessions: createDbSessionResolver(db),
      notifier,
    });
    const base = { schedule: "0 * * * *", timezone: "UTC" } as const;
    const a = await scheduler.create({
      kind: "cron",
      title: "A",
      prompt: jobMarker("echo", "x1"),
      system: true,
      ...base,
    });
    const b = await scheduler.create({
      kind: "cron",
      title: "B",
      prompt: "Triage my inbox",
      ...base,
    });
    const c = await scheduler.create({
      kind: "cron",
      title: "C",
      prompt: jobMarker("boom", "x2"),
      system: true,
      ...base,
    });
    for (const x of [a, b, c]) await scheduler.trigger(x.id);
    await scheduler.idle();
    expect(seen).toEqual(["x1"]);
    expect(agent.requests.map((r) => r.automation.title)).toEqual(["B"]);
    expect(scheduler.runs(a.id).runs[0]).toMatchObject({
      status: "no_reply",
      summary: "echoed",
      taskId: null,
    });
    expect(scheduler.runs(c.id).runs[0]).toMatchObject({
      status: "failed",
      summary: "boom failed",
    });
    expect(errors).toHaveLength(1);
    // The job's error detail stays in the log; the owner sees one task_failed for C only.
    const failed = (await notifier.list()).filter((n) => n.kind === "task_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.body).toBe("boom failed");
  });

  it("markers and cadences parse strictly", () => {
    expect(parseJobMarker(jobMarker("goal-checkin", "g1"))).toEqual({
      job: "goal-checkin",
      arg: "g1",
      rest: "",
    });
    expect(parseJobMarker("[psyche:goal-checkin g1] and more")).toBeUndefined();
    expect(parseJobMarker(`${jobMarker("feed-briefing", "b1")}\ntwo things in robotics\n`)).toEqual(
      {
        job: "feed-briefing",
        arg: "b1",
        rest: "two things in robotics",
      },
    );
    expect(parseJobMarker("Triage my inbox")).toBeUndefined();
    expect(cadenceKind("0 8 * * 1")).toBe("cron");
    expect(cadenceKind("PT30M")).toBe("interval");
    expect(cadenceKind("P1D")).toBe("interval");
  });
});
