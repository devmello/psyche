import { openDb } from "@psyche/db";
import { ensureDreamingAutomation } from "@psyche/memory";
import { confirmWorkflow, jobMarker } from "@psyche/proactive";
import type { DailyWorkflowProposal } from "@psyche/protocol";
import {
  createAutomationHandlers,
  createDbSessionResolver,
  createDeliverer,
  type RunLauncher,
  SqliteScheduler,
} from "@psyche/scheduler";
import { FakeClock, FakeNotifier } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  createScheduledHandlers,
  pausedRoutines,
  summaryOf,
  withPausedRoutines,
} from "../src/compose/scheduled.ts";

// Wednesday 2026-10-28 08:00 in Los Angeles.
const NOW = Date.parse("2026-10-28T15:00:00Z");
const TZ = "America/Los_Angeles";

function setup() {
  const clock = new FakeClock(NOW);
  const db = openDb(":memory:");
  const notifier = new FakeNotifier({ clock });
  const launched: string[] = [];
  const launcher: RunLauncher = {
    async launch(request) {
      launched.push(request.automation.title);
      return { result: Promise.resolve({ status: "done" as const, summary: "ok" }) };
    },
  };
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
  const store = new Map<string, unknown>();
  const kv = {
    get: (k: string) => store.get(k),
    set: (k: string, v: unknown) => void store.set(k, v),
  };
  const handlers = createScheduledHandlers({ scheduler, kv, timezone: () => TZ });
  return { scheduler, kv, handlers, launched };
}

const PROPOSAL: DailyWorkflowProposal = {
  groupId: "grp_1",
  title: "Daily groceries",
  notify: "notification",
  timezone: TZ,
  runs: [
    {
      name: "Add to cart",
      kind: "cron",
      schedule: "0 9 * * *",
      humanSchedule: "Every day at 9:00 AM",
      prompt: "Add the usual groceries to the cart.",
      steps: ["Open the shop"],
    },
    {
      name: "Check the order",
      kind: "cron",
      schedule: "30 23 * * *",
      humanSchedule: "Every day at 11:30 PM",
      prompt: "Check that the order went through.",
      steps: ["Open the shop"],
    },
  ],
} as never;

describe("scheduled.list", () => {
  it("lists the owner's automations first, then Psyche's routines, with next runs", async () => {
    const { scheduler, handlers } = setup();
    await scheduler.create({
      kind: "cron",
      title: "Friday recap",
      schedule: "0 17 * * 5",
      prompt: "Summarise what I shipped this week.\n\nKeep it short.",
    });
    await ensureDreamingAutomation(scheduler, { timezone: TZ });
    await scheduler.create({
      kind: "cron",
      system: true,
      title: "Morning brief",
      schedule: "0 8 * * *",
      timezone: TZ,
      prompt: jobMarker("daily-brief", "daily"),
    });

    const { timezone, items } = await handlers["scheduled.list"]({});
    expect(timezone).toBe(TZ);
    expect(items.map((i) => [i.group, i.routine ?? i.title])).toEqual([
      ["owner", "Friday recap"],
      // Tomorrow 03:00 is sooner than the brief's tomorrow 08:00.
      ["routine", "memory-dreaming"],
      ["routine", "daily-brief"],
    ]);
    const owner = items[0];
    expect(owner).toMatchObject({
      state: "active",
      enabled: true,
      deletable: true,
      summary: "Summarise what I shipped this week.",
      approvals: ["queued"],
      schedule: "0 17 * * 5",
    });
    expect(owner?.nextRunAt).toBe("2026-10-31T00:00:00.000Z");
    const brief = items[2];
    expect(brief).toMatchObject({ deletable: false, settings: "daily", summary: "" });
    expect(brief?.prompt).toBeUndefined();
  });

  it("links the runs of a task → automation workflow", async () => {
    const { scheduler, handlers } = setup();
    await confirmWorkflow(scheduler, PROPOSAL);
    const { items } = await handlers["scheduled.list"]({});
    expect(items).toHaveLength(2);
    const morning = items.find((i) => i.title.endsWith("Add to cart"));
    expect(morning?.summary).toBe("Add the usual groceries to the cart.");
    expect(morning?.linked?.groupId).toBe("grp_1");
    expect(morning?.linked?.runs.map((r) => r.title)).toEqual(["Daily groceries: Check the order"]);
    const evening = items.find((i) => i.title.endsWith("Check the order"));
    expect(evening?.linked?.runs.map((r) => r.title)).toEqual(["Daily groceries: Add to cart"]);
  });

  it("shows a routine its own Settings switch turned off as off, not paused", async () => {
    const { scheduler, handlers } = setup();
    await scheduler.create({
      kind: "cron",
      system: true,
      enabled: false,
      title: "Morning brief",
      schedule: "0 8 * * *",
      prompt: jobMarker("daily-brief", "daily"),
    });
    const { items } = await handlers["scheduled.list"]({});
    expect(items[0]).toMatchObject({ state: "off", enabled: false, nextRunAt: null });
  });
});

describe("scheduled.pause", () => {
  it("switches an owner automation off and on", async () => {
    const { scheduler, handlers } = setup();
    const a = await scheduler.create({
      kind: "cron",
      title: "Recap",
      schedule: "0 17 * * 5",
      prompt: "Recap.",
    });
    const paused = await handlers["scheduled.pause"]({ id: a.id, paused: true });
    expect(paused.item).toMatchObject({ state: "paused", nextRunAt: null });
    expect((await scheduler.get(a.id))?.enabled).toBe(false);
    const resumed = await handlers["scheduled.pause"]({ id: a.id, paused: false });
    expect(resumed.item.state).toBe("active");
    expect(resumed.item.nextRunAt).not.toBeNull();
  });

  it("pauses a routine without touching its automation, and its scheduled runs are skipped", async () => {
    const { scheduler, handlers, kv } = setup();
    const a = await scheduler.create({
      kind: "cron",
      system: true,
      title: "Morning brief",
      schedule: "0 8 * * *",
      prompt: jobMarker("daily-brief", "daily"),
    });
    const { item } = await handlers["scheduled.pause"]({ id: a.id, paused: true });
    expect(item).toMatchObject({ state: "paused", nextRunAt: null });
    // The owner of the automation re-writes `enabled` from Settings at start; the pause stays.
    expect((await scheduler.get(a.id))?.enabled).toBe(true);
    expect(pausedRoutines(kv).has("daily-brief:daily")).toBe(true);

    const inner = { launch: async () => ({ result: Promise.resolve({ status: "done" }) }) };
    const wrapped = withPausedRoutines(inner as never, () => pausedRoutines(kv)) as never as {
      launch(r: unknown): Promise<{ result: Promise<{ status: string }> }>;
    };
    const scheduled = await wrapped.launch({ automation: a, run: { trigger: "schedule" } });
    expect((await scheduled.result).status).toBe("no_reply");
    const manual = await wrapped.launch({ automation: a, run: { trigger: "manual" } });
    expect((await manual.result).status).toBe("done");

    const back = await handlers["scheduled.pause"]({ id: a.id, paused: false });
    expect(back.item.state).toBe("active");
  });

  it("rejects an unknown id", async () => {
    const { handlers } = setup();
    await expect(handlers["scheduled.pause"]({ id: "nope", paused: true })).rejects.toThrow(
      /not found/,
    );
  });
});

describe("automations.delete", () => {
  it("refuses Psyche's routines and still deletes the owner's", async () => {
    const { scheduler } = setup();
    const h = createAutomationHandlers(scheduler);
    const routine = await ensureDreamingAutomation(scheduler, { timezone: TZ });
    await expect(h["automations.delete"]({ automationId: routine.id })).rejects.toThrow(
      /paused, not deleted/,
    );
    const mine = await scheduler.create({
      kind: "cron",
      title: "Recap",
      schedule: "0 17 * * 5",
      prompt: "Recap.",
    });
    await h["automations.delete"]({ automationId: mine.id });
    expect(await scheduler.get(mine.id)).toBeUndefined();
  });
});

describe("summaryOf", () => {
  it("is the first line of the instruction, trimmed", () => {
    expect(summaryOf("  Do the thing   now.\nThen more.")).toBe("Do the thing now.");
    expect(summaryOf("x".repeat(300))).toHaveLength(200);
  });
});
