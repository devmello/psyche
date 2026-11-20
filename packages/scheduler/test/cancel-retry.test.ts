import { describe, expect, it } from "vitest";
import type { RunResult } from "../src/index.ts";
import { BASE, type RecordingLauncher, setup } from "./helpers.ts";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-19T12:00:00Z");
const OVERLOADED = `529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`;

/** A launcher answering with `results` in order (the last one repeats). */
function answering(launcher: RecordingLauncher, results: RunResult[]): void {
  let n = 0;
  launcher.respond = () => results[Math.min(n++, results.length - 1)] as RunResult;
}

async function waiting() {
  const s = setup({ start: T0, random: () => 0 });
  await s.scheduler.start();
  const a = await s.scheduler.create({ ...BASE, kind: "interval", schedule: "PT1H" });
  answering(s.launcher, [
    { status: "failed", summary: OVERLOADED, noSideEffects: true },
    { status: "done", summary: "ok" },
  ]);
  s.clock.advance(HOUR);
  await s.scheduler.wake();
  await s.scheduler.idle();
  const row = s.db.sqlite.prepare("SELECT id FROM automation_runs").get() as { id: string };
  return { ...s, a, runId: row.id };
}

describe("cancel retry", () => {
  it("ends the waiting run as cancelled, keeps the error, and never fires the retry", async () => {
    const { scheduler, clock, launcher, db, a, runId } = await waiting();
    expect(scheduler.isRunning(a.id)).toBe(true);
    const run = await scheduler.cancelRetry(runId);
    expect(run.status).toBe("cancelled");
    expect(run.retryAt ?? null).toBeNull();
    expect(run.summary).toContain("Retry cancelled");
    expect(run.summary).toContain("overloaded_error");
    expect(run.endedAt).not.toBeNull();
    expect(scheduler.isRunning(a.id)).toBe(false);
    expect(db.sqlite.prepare("SELECT last_status FROM automations WHERE id = ?").get(a.id)).toEqual(
      { last_status: "failed" },
    );
    // The cancelled timer does not launch another attempt.
    clock.advance(10 * 60_000);
    await scheduler.idle();
    expect(launcher.requests).toHaveLength(1);
    expect(scheduler.activeRunCount()).toBe(0);
    // Run now is free again.
    await expect(scheduler.runNow(a.id)).resolves.toBeDefined();
    scheduler.stop();
  });

  it("refuses a run that already retried, and an unknown run", async () => {
    const { scheduler, clock, db, runId } = await waiting();
    clock.advance(60_000);
    await scheduler.idle();
    expect(db.sqlite.prepare("SELECT status FROM automation_runs").get()).toEqual({
      status: "done",
    });
    await expect(scheduler.cancelRetry(runId)).rejects.toMatchObject({ code: "conflict" });
    await expect(scheduler.cancelRetry("nope")).rejects.toMatchObject({ code: "not_found" });
    scheduler.stop();
  });

  it("refuses a running run that has no retry waiting (a manual run)", async () => {
    const s = setup({ start: T0 });
    await s.scheduler.start();
    const b = await s.scheduler.create({ ...BASE, kind: "interval", schedule: "PT1H" });
    const { run } = await s.scheduler.trigger(b.id);
    await expect(s.scheduler.cancelRetry(run.id)).rejects.toMatchObject({ code: "conflict" });
    s.scheduler.stop();
  });
});
