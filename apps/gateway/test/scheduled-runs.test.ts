import { openDb } from "@psyche/db";
import { jobMarker } from "@psyche/proactive";
import {
  createAutomationHandlers,
  createDbSessionResolver,
  createDeliverer,
  type RunLauncher,
  type RunResult,
  SqliteScheduler,
} from "@psyche/scheduler";
import { FakeClock, FakeNotifier } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { createScheduledHandlers, runState, withPausedRoutines } from "../src/compose/scheduled.ts";

const NOW = Date.parse("2026-10-28T15:00:00Z");
const TZ = "America/Los_Angeles";

/** A scheduler whose launcher answers per automation title; `hold` runs stay running. */
function setup(outcomes: Record<string, RunResult | "hold" | "throw"> = {}) {
  const clock = new FakeClock(NOW);
  const db = openDb(":memory:");
  const notifier = new FakeNotifier({ clock });
  const launched: string[] = [];
  const inner: RunLauncher = {
    async launch(request) {
      launched.push(request.automation.title);
      const o = outcomes[request.automation.title] ?? { status: "done", summary: "ok" };
      if (o === "throw") throw new Error("the worker pool is gone");
      return {
        taskId: `task_${launched.length}`,
        result: o === "hold" ? new Promise<RunResult>(() => {}) : Promise.resolve(o),
      };
    },
  };
  const paused = new Set<string>();
  const launcher = withPausedRoutines(inner, () => paused);
  const scheduler = new SqliteScheduler({
    db,
    clock,
    timers: { setTimeout: () => undefined, clearTimeout: () => {} },
    launcher,
    sessions: createDbSessionResolver(db),
    notifier,
    deliverer: createDeliverer({ notifier, sendToChannel: async () => {} }),
    defaultTimezone: TZ,
  });
  const taskStatuses = new Map<string, string>();
  const pending = new Map<string, number>();
  const kv = { get: () => undefined, set: () => {} };
  const handlers = createScheduledHandlers({
    scheduler,
    kv,
    timezone: () => TZ,
    taskStatus: async (id) => taskStatuses.get(id),
    pendingApprovals: async () => pending,
  });
  return {
    scheduler,
    handlers,
    auto: createAutomationHandlers(scheduler),
    taskStatuses,
    pending,
    paused,
    launched,
  };
}

const owner = (title: string) => ({
  kind: "cron" as const,
  title,
  schedule: "0 17 * * 5",
  prompt: `${title}.`,
});
const routine = (title: string) => ({
  kind: "cron" as const,
  system: true,
  title,
  schedule: "0 8 * * *",
  timezone: TZ,
  prompt: jobMarker("daily-brief", "daily"),
});

describe("Run now (automations.run)", () => {
  it("runs an owner automation through the launcher and records a manual run", async () => {
    const { scheduler, auto, handlers, launched } = setup();
    const a = await scheduler.create(owner("Friday recap"));
    const res = await auto["automations.run"]({ automationId: a.id });
    expect(res.runId).toBeTruthy();
    expect(res.taskId).toBe("task_1");
    await scheduler.idle();
    expect(launched).toEqual(["Friday recap"]);
    const { runs } = await handlers["scheduled.runs"]({});
    expect(runs[0]).toMatchObject({ trigger: "manual", state: "succeeded", group: "owner" });
  });

  it("runs a built-in routine, even while it is paused in Scheduled", async () => {
    const { scheduler, auto, handlers, paused, launched } = setup();
    const a = await scheduler.create(routine("Morning brief"));
    paused.add("daily-brief:daily");
    await auto["automations.run"]({ automationId: a.id });
    await scheduler.idle();
    expect(launched).toEqual(["Morning brief"]);
    const { runs } = await handlers["scheduled.runs"]({});
    expect(runs[0]).toMatchObject({
      group: "routine",
      routine: "daily-brief",
      trigger: "manual",
      state: "succeeded",
    });
  });

  it("answers with an error when the automation is unknown or already running", async () => {
    const { scheduler, auto } = setup({ Hold: "hold" });
    await expect(auto["automations.run"]({ automationId: "nope" })).rejects.toThrow(/not found/);
    const a = await scheduler.create(owner("Hold"));
    await auto["automations.run"]({ automationId: a.id });
    await expect(auto["automations.run"]({ automationId: a.id })).rejects.toThrow(
      /already in progress/,
    );
  });

  it("records a failed run, not a success, when the launcher throws", async () => {
    const { scheduler, auto, handlers } = setup({ Broken: "throw" });
    const a = await scheduler.create(owner("Broken"));
    await auto["automations.run"]({ automationId: a.id });
    await scheduler.idle();
    const { runs } = await handlers["scheduled.runs"]({});
    expect(runs[0]).toMatchObject({
      state: "failed",
      reason: "the worker pool is gone",
    });
  });
});

describe("scheduled.runs", () => {
  it("lists background, in-progress, failed and skipped runs with their reasons", async () => {
    const { scheduler, auto, handlers, taskStatuses, pending } = setup({
      Failing: { status: "failed", summary: "the shop was down", taskId: "t_f" },
      Skipping: { status: "no_reply", summary: "on battery" },
      Holding: "hold",
      Waiting: "hold",
    });
    const ids: Record<string, string> = {};
    for (const title of ["Failing", "Skipping", "Holding", "Waiting"]) {
      ids[title] = (await scheduler.create(owner(title))).id;
    }
    ids.Brief = (await scheduler.create(routine("Morning brief"))).id;
    for (const title of Object.keys(ids)) {
      await auto["automations.run"]({ automationId: ids[title] as string });
      // `idle()` would wait forever on the held runs: let the finished ones settle instead.
      await new Promise((r) => setTimeout(r, 5));
    }
    // "Waiting" is the 4th launch: its task is parked on two approvals.
    taskStatuses.set("task_4", "awaiting_approval");
    pending.set("task_4", 2);

    const { runs } = await handlers["scheduled.runs"]({});
    const byTitle = Object.fromEntries(runs.map((r) => [r.title, r]));
    expect(byTitle.Failing).toMatchObject({ state: "failed", reason: "the shop was down" });
    expect(byTitle.Skipping).toMatchObject({ state: "skipped", reason: "on battery" });
    expect(byTitle.Holding).toMatchObject({ state: "running", durationMs: null });
    expect(byTitle.Waiting).toMatchObject({ state: "waiting", pendingApprovals: 2 });
    expect(byTitle["Morning brief"]).toMatchObject({ group: "routine", state: "succeeded" });

    const waiting = await handlers["scheduled.runs"]({ state: "waiting" });
    expect(waiting.runs.map((r) => r.title)).toEqual(["Waiting"]);
    const one = await handlers["scheduled.runs"]({ automationId: ids.Failing as string });
    expect(one.runs.map((r) => r.title)).toEqual(["Failing"]);
  });

  it("shows a no-reply run without a reason as skipped, never as succeeded", async () => {
    const { scheduler, auto, handlers } = setup({ Quiet: { status: "no_reply", summary: null } });
    const a = await scheduler.create(owner("Quiet"));
    await auto["automations.run"]({ automationId: a.id });
    await scheduler.idle();
    const { runs } = await handlers["scheduled.runs"]({});
    expect(runs[0]).toMatchObject({ state: "skipped", reason: "Nothing to report" });
  });

  it("maps scheduler statuses to one display state", () => {
    expect(runState("done")).toBe("succeeded");
    expect(runState("failed")).toBe("failed");
    expect(runState("cancelled")).toBe("cancelled");
    expect(runState("skipped")).toBe("skipped");
    expect(runState("no_reply")).toBe("skipped");
    expect(runState("running")).toBe("running");
    expect(runState("running", "awaiting_approval")).toBe("waiting");
  });
});
