import { describe, expect, it } from "vitest";
import {
  isTransientModelError,
  MAX_RETRIES,
  RETRY_BACKOFF_MS,
  type RunResult,
  retryDelayMs,
} from "../src/index.ts";
import { BASE, type RecordingLauncher, setup } from "./helpers.ts";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-19T12:00:00Z");
const OVERLOADED = `529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`;

describe("transient model errors", () => {
  it("retries on 429, 5xx and overloaded", () => {
    for (const msg of [
      "429 rate limited",
      "HTTP 500 internal",
      "502 bad gateway",
      "status: 503",
      "statusCode: 504",
      OVERLOADED,
      '{"type":"overloaded_error"}',
      "rate_limit_error: slow down",
    ]) {
      expect(isTransientModelError(msg), msg).toBe(true);
    }
  });

  it("never retries auth or request errors, or a number that is not a status", () => {
    for (const msg of [
      '401 {"type":"error","error":{"type":"authentication_error"}}',
      "403 forbidden",
      "400 invalid_request_error: max_tokens too large",
      "404 not found",
      "The file has 500 rows",
      "timed out after 30000 ms",
      "",
    ]) {
      expect(isTransientModelError(msg), msg).toBe(false);
    }
  });
});

describe("retry backoff", () => {
  it("waits 1, 5 and 15 minutes, with jitter added on top", () => {
    expect(RETRY_BACKOFF_MS).toEqual([60_000, 300_000, 900_000]);
    expect(MAX_RETRIES).toBe(3);
    expect(retryDelayMs(1, () => 0)).toBe(60_000);
    expect(retryDelayMs(2, () => 0)).toBe(300_000);
    expect(retryDelayMs(3, () => 0)).toBe(900_000);
    // Jitter is at most 20% of the backoff.
    expect(retryDelayMs(1, () => 0.99)).toBe(60_000 + 11_880);
    expect(retryDelayMs(3, () => 0.5)).toBe(900_000 + 90_000);
    expect(() => retryDelayMs(4)).toThrow(RangeError);
  });
});

/** A launcher answering with `results` in order (the last one repeats). */
function answering(launcher: RecordingLauncher, results: RunResult[]): void {
  let n = 0;
  launcher.respond = () => results[Math.min(n++, results.length - 1)] as RunResult;
}

describe("scheduled run retry", () => {
  it("retries a 529 after 1 minute and records the retry time", async () => {
    const { scheduler, clock, launcher, db } = setup({ start: T0, random: () => 0 });
    await scheduler.start();
    const a = await scheduler.create({ ...BASE, kind: "interval", schedule: "PT1H" });
    answering(launcher, [
      { status: "failed", summary: OVERLOADED, noSideEffects: true },
      { status: "done", summary: "ok" },
    ]);
    clock.advance(HOUR);
    await scheduler.wake();
    await scheduler.idle();
    const [first] = db.sqlite
      .prepare("SELECT status, attempt, retry_at FROM automation_runs")
      .all() as { status: string; attempt: number; retry_at: string }[];
    expect(first).toEqual({
      status: "running",
      attempt: 1,
      retry_at: new Date(T0 + HOUR + 60_000).toISOString(),
    });
    // The run is still running while it waits, so the Scheduled screen shows it as retrying.
    expect((await scheduler.list())[0]?.id).toBe(a.id);
    clock.advance(60_000);
    await scheduler.idle();
    expect(launcher.requests).toHaveLength(2);
    expect(db.sqlite.prepare("SELECT status, retry_at FROM automation_runs").get()).toEqual({
      status: "done",
      retry_at: null,
    });
    scheduler.stop();
  });

  it("gives up after three retries with the final failure, on the 1/5/15 minute schedule", async () => {
    const { scheduler, clock, launcher, db } = setup({ start: T0, random: () => 0 });
    await scheduler.start();
    await scheduler.create({ ...BASE, kind: "interval", schedule: "PT1H" });
    answering(launcher, [{ status: "failed", summary: OVERLOADED, noSideEffects: true }]);
    clock.advance(HOUR);
    await scheduler.wake();
    await scheduler.idle();
    const gaps = [60_000, 300_000, 900_000];
    for (const gap of gaps) {
      clock.advance(gap);
      await scheduler.idle();
    }
    expect(launcher.requests).toHaveLength(4);
    expect(db.sqlite.prepare("SELECT status, attempt FROM automation_runs").get()).toEqual({
      status: "failed",
      attempt: 3,
    });
    scheduler.stop();
  });

  it("does not retry an auth error", async () => {
    const { scheduler, clock, launcher, db } = setup({ start: T0 });
    await scheduler.start();
    await scheduler.create({ ...BASE, kind: "interval", schedule: "PT1H" });
    answering(launcher, [
      {
        status: "failed",
        summary: '401 {"error":{"type":"authentication_error"}}',
        noSideEffects: true,
      },
    ]);
    clock.advance(HOUR);
    await scheduler.wake();
    await scheduler.idle();
    expect(launcher.requests).toHaveLength(1);
    expect(db.sqlite.prepare("SELECT status, retry_at FROM automation_runs").get()).toEqual({
      status: "failed",
      retry_at: null,
    });
    scheduler.stop();
  });

  it("does not retry after a side-effecting step, or when it cannot tell", async () => {
    for (const noSideEffects of [false, undefined]) {
      const { scheduler, clock, launcher, db } = setup({ start: T0 });
      await scheduler.start();
      await scheduler.create({ ...BASE, kind: "interval", schedule: "PT1H" });
      answering(launcher, [{ status: "failed", summary: OVERLOADED, noSideEffects }]);
      clock.advance(HOUR);
      await scheduler.wake();
      await scheduler.idle();
      expect(launcher.requests).toHaveLength(1);
      expect(db.sqlite.prepare("SELECT status FROM automation_runs").get()).toEqual({
        status: "failed",
      });
      scheduler.stop();
    }
  });

  it("never retries a manual run", async () => {
    const { scheduler, launcher, db } = setup({ start: T0 });
    await scheduler.start();
    const a = await scheduler.create({ ...BASE, kind: "interval", schedule: "PT1H" });
    answering(launcher, [{ status: "failed", summary: OVERLOADED, noSideEffects: true }]);
    await scheduler.runNow(a.id);
    await scheduler.idle();
    expect(launcher.requests).toHaveLength(1);
    expect(db.sqlite.prepare("SELECT status FROM automation_runs").get()).toEqual({
      status: "failed",
    });
    scheduler.stop();
  });

  it("a waiting retry survives a restart and fires on the new scheduler", async () => {
    const first = setup({ start: T0, random: () => 0 });
    await first.scheduler.start();
    await first.scheduler.create({ ...BASE, kind: "interval", schedule: "PT1H" });
    answering(first.launcher, [{ status: "failed", summary: OVERLOADED, noSideEffects: true }]);
    first.clock.advance(HOUR);
    await first.scheduler.wake();
    await first.scheduler.idle();
    first.scheduler.stop();

    const second = setup({ start: T0 + HOUR + 10_000, db: first.db });
    answering(second.launcher, [{ status: "done", summary: "ok" }]);
    await second.scheduler.start();
    second.clock.advance(60_000);
    await second.scheduler.idle();
    expect(second.launcher.requests).toHaveLength(1);
    expect(first.db.sqlite.prepare("SELECT status FROM automation_runs").get()).toEqual({
      status: "done",
    });
    second.scheduler.stop();
  });
});
