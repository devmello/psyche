import { APPROVAL_TTL_MS } from "@psyche/protocol";
import { createWakeDetector, SqliteTaskEngine } from "@psyche/tasks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AutomationRunRequest,
  createTaskLauncher,
  INTERRUPTED_SUMMARY,
  type RunLauncher,
} from "../src/index.ts";
import { asleep, BASE, setup } from "./helpers.ts";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-24T05:00:00Z");

/** An in-process job: no task, and its result never arrives (the process dies first). */
class HangingLauncher implements RunLauncher {
  readonly requests: AutomationRunRequest[] = [];
  /** Jobs that read and propose only say yes; any other (and any future) job is not rerun. */
  rerunOnInterrupt = (_: unknown): boolean => true;
  async launch(request: AutomationRunRequest) {
    this.requests.push(request);
    return { result: new Promise<never>(() => {}) };
  }
}

describe("a scheduled run a restart cut off", () => {
  async function interrupted(options: { trigger?: "schedule" | "manual" } = {}) {
    const hang = new HangingLauncher();
    const first = setup({ start: T0, timers: asleep, launcher: hang });
    await first.scheduler.start();
    const a = await first.scheduler.create({ ...BASE, kind: "interval", schedule: "PT1H" });
    if (options.trigger === "manual") {
      void first.scheduler.trigger(a.id);
      await vi.waitFor(() => expect(hang.requests).toHaveLength(1));
    } else {
      first.clock.advance(HOUR);
      await first.scheduler.wake();
      await vi.waitFor(() => expect(hang.requests).toHaveLength(1));
    }
    first.scheduler.stop();
    return { db: first.db, a };
  }

  it("becomes due again once and runs, with no notification", async () => {
    const { db, a } = await interrupted();
    const second = setup({ start: T0 + HOUR + 20_000, db, timers: asleep });
    second.launcher.rerunOnInterrupt = () => true;
    await second.scheduler.start();
    await second.scheduler.idle();
    const runs = second.scheduler.runs(a.id).runs;
    expect(runs.map((r) => [r.status, r.summary])).toEqual(
      expect.arrayContaining([
        ["cancelled", INTERRUPTED_SUMMARY],
        ["done", expect.stringContaining("Result of")],
      ]),
    );
    expect(second.launcher.requests).toHaveLength(1);
    // The 07:00 brief for this slot, not a different one.
    const scheduled = new Set(runs.map((r) => r.scheduledFor));
    expect(scheduled.size).toBe(1);
    expect((await second.notifier.list()).map((n) => n.kind)).toEqual(["task_done"]);
    // The next slot is still the normal next one.
    expect((await second.scheduler.get(a.id))?.nextRunAt).toBe(
      new Date(T0 + 2 * HOUR).toISOString(),
    );
  });

  it("is not run a second time when the rerun is cut off too: the owner is told", async () => {
    const { db, a } = await interrupted();
    // Second boot: the rerun starts and hangs (cut off again).
    const hang = new HangingLauncher();
    const second = setup({ start: T0 + HOUR + 20_000, db, timers: asleep, launcher: hang });
    await second.scheduler.start();
    await vi.waitFor(() => expect(hang.requests).toHaveLength(1));
    second.scheduler.stop();
    // Third boot.
    const third = setup({ start: T0 + HOUR + 40_000, db, timers: asleep });
    // It would rerun (the job opted in); the second cut-off is what stops it.
    third.launcher.rerunOnInterrupt = () => true;
    await third.scheduler.start();
    await third.scheduler.idle();
    expect(third.launcher.requests).toHaveLength(0);
    const notices = await third.notifier.list();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind).toBe("task_failed");
    expect(notices[0]?.message?.titleKey).toBe("notice.automation.interrupted.title");
    expect(notices[0]?.message?.params).toEqual({ title: BASE.title });
    expect(third.scheduler.isRunning(a.id)).toBe(false);
  });

  it("a job that does not opt in is not rerun: the owner is told", async () => {
    const { db, a } = await interrupted();
    const second = setup({ start: T0 + HOUR + 20_000, db, timers: asleep });
    second.launcher.rerunOnInterrupt = () => false;
    await second.scheduler.start();
    await second.scheduler.idle();
    expect(second.launcher.requests).toHaveLength(0);
    const notices = await second.notifier.list();
    expect(notices.map((n) => n.message?.titleKey)).toEqual([
      "notice.automation.interrupted.title",
    ]);
    expect(second.scheduler.isRunning(a.id)).toBe(false);
  });

  it("a manual run is not repeated and does not notify", async () => {
    const { db, a } = await interrupted({ trigger: "manual" });
    const second = setup({ start: T0 + 20_000, db, timers: asleep });
    await second.scheduler.start();
    await second.scheduler.idle();
    expect(second.launcher.requests).toHaveLength(0);
    expect(await second.notifier.list()).toEqual([]);
    expect(second.scheduler.runs(a.id).runs[0]?.summary).toBe(INTERRUPTED_SUMMARY);
  });
});

describe("a run parked on an approval", () => {
  it("ends as needing approval when the approval expires, frees the automation, notifies once", async () => {
    const first = setup({ start: T0, timers: asleep });
    const { db, clock } = first;
    const engine = new SqliteTaskEngine({ db, clock });
    const s = setup({ start: T0, db, timers: asleep, launcher: createTaskLauncher({ engine }) });
    const a = await s.scheduler.create({ ...BASE, kind: "interval", schedule: "PT1H" });
    const { taskId } = await s.scheduler.trigger(a.id);
    const lease = await engine.claim("w", { leaseMs: 10_000 });
    expect(lease?.taskId).toBe(taskId);
    await engine.parkForApproval(
      taskId as string,
      { approvalId: "appr_1", stepId: null },
      { lease: lease as never },
    );
    expect(s.scheduler.activeRunCount()).toBe(1);
    // Later ticks would be skipped while the run is parked.
    clock.advance(APPROVAL_TTL_MS + 1);
    await engine.resolveApproval(taskId as string, { id: "appr_1", status: "expired" });
    await s.scheduler.idle();
    const run = s.scheduler.runs(a.id).runs[0];
    expect(run?.status).toBe("cancelled");
    expect(run?.summary).toContain("Needs approval");
    expect(s.scheduler.activeRunCount()).toBe(0);
    expect(s.scheduler.isRunning(a.id)).toBe(false);
    const notices = await s.notifier.list();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message?.titleKey).toBe("notice.automation.needsApproval.title");
    expect(notices[0]?.message?.params).toEqual({ title: BASE.title });
    // The task is over: the same card is not raised again.
    expect(await engine.claim("w", { leaseMs: 10_000 })).toBeUndefined();
    // The next run is not skipped.
    const again = await s.scheduler.trigger(a.id);
    expect(again.run.status).toBe("running");
  });
});

describe("wake detection", () => {
  afterEach(() => vi.useRealTimers());

  it("a sleep makes the scheduler catch up at once and renew leases, not up to 5 minutes later", async () => {
    vi.useFakeTimers();
    // The scheduler's own timer never fires (the process was frozen); only the detector looks.
    const s = setup({ start: T0, timers: asleep });
    await s.scheduler.start();
    await s.scheduler.create({ ...BASE, kind: "interval", schedule: "PT1H" });
    let wall = Date.now();
    let mono = 0;
    const renew = vi.fn(async () => {});
    const detector = createWakeDetector({
      wallNow: () => wall,
      monotonicNow: () => mono,
      intervalMs: 20_000,
      onWake: async () => {
        await renew();
        await s.scheduler.wake();
      },
    });
    detector.start();
    // An hour passes while the Mac sleeps: wall clock and the scheduler's clock move, mono does not.
    wall += HOUR + 1_000;
    s.clock.advance(HOUR + 1_000);
    expect(s.launcher.requests).toHaveLength(0);
    mono += 20_000;
    wall += 20_000;
    await vi.advanceTimersByTimeAsync(20_000);
    await s.scheduler.idle();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(s.launcher.requests).toHaveLength(1);
    detector.stop();
  });
});

describe("default time zone", () => {
  it("a function default follows the owner's zone as it changes; stored automations keep theirs", async () => {
    let zone = "America/Los_Angeles";
    const { timezone: _tz, ...noZone } = BASE;
    const s = setup({ start: T0, timers: asleep, defaultTimezone: () => zone });
    const before = await s.scheduler.create({ ...noZone, kind: "cron", schedule: "0 7 * * *" });
    zone = "Europe/Berlin";
    const after = await s.scheduler.create({ ...noZone, kind: "cron", schedule: "0 7 * * *" });
    expect(before.timezone).toBe("America/Los_Angeles");
    expect(after.timezone).toBe("Europe/Berlin");
    expect((await s.scheduler.get(before.id))?.timezone).toBe("America/Los_Angeles");
  });
});
