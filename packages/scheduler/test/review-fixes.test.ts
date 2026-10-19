import { SqliteTaskEngine } from "@psyche/tasks";
import { describe, expect, it } from "vitest";
import { createTaskLauncher, parsePrice, parseSchedule } from "../src/index.ts";
import { asleep, BASE, setup } from "./helpers.ts";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-19T12:00:00Z");

describe("scheduler review fixes", () => {
  it("rejects a reminder whose time has passed", async () => {
    const { scheduler } = setup({ start: T0, timers: asleep });
    await expect(
      scheduler.create({ ...BASE, kind: "reminder", schedule: new Date(T0 - HOUR).toISOString() }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("re-sending the same schedule keeps next_run_at (catch-up, backoff, phase)", async () => {
    const { scheduler, clock } = setup({ start: T0, timers: asleep });
    const a = await scheduler.create({ ...BASE, kind: "interval", schedule: "PT1H" });
    clock.advance(20 * 60_000);
    const same = await scheduler.update(a.id, { schedule: "PT1H", title: "Renamed" });
    expect(same.nextRunAt).toBe(a.nextRunAt);
    const moved = await scheduler.update(a.id, { schedule: "PT2H" });
    expect(moved.nextRunAt).toBe(new Date(T0 + 20 * 60_000 + 2 * HOUR).toISOString());
  });

  it("an automation with no delivery target still reaches the inbox", async () => {
    const { scheduler, notifier } = setup({ start: T0, timers: asleep });
    const r = await scheduler.create({
      ...BASE,
      kind: "reminder",
      title: "Call the dentist",
      schedule: new Date(T0 + HOUR).toISOString(),
    });
    await scheduler.trigger(r.id);
    await scheduler.idle();
    expect((await notifier.list()).map((n) => [n.kind, n.title])).toEqual([
      ["reminder", "Call the dentist"],
    ]);
  });

  it("deleting an automation cancels its running task", async () => {
    const { db, clock } = setup({ start: T0, timers: asleep });
    const engine = new SqliteTaskEngine({ db, clock });
    const { scheduler } = setup({
      start: T0,
      db,
      timers: asleep,
      launcher: createTaskLauncher({ engine }),
    });
    const a = await scheduler.create({ ...BASE, kind: "cron", schedule: "0 * * * *" });
    const { taskId } = await scheduler.trigger(a.id);
    await scheduler.remove(a.id);
    expect((await engine.get(taskId as string))?.status).toBe("cancelled");
    await scheduler.idle();
  });

  it("refuses a manual run while one is in progress", async () => {
    const { scheduler, launcher } = setup({ start: T0, timers: asleep });
    let release!: () => void;
    launcher.respond = () =>
      new Promise((r) => {
        release = () => r({ status: "done", summary: "ok" });
      });
    const a = await scheduler.create({ ...BASE, kind: "cron", schedule: "0 * * * *" });
    await scheduler.trigger(a.id);
    await expect(scheduler.trigger(a.id)).rejects.toMatchObject({ code: "conflict" });
    release();
    await scheduler.idle();
  });

  it("folds a long sleep cheaply and keeps the phase", () => {
    const every5 = parseSchedule("cron", "*/5 * * * *", "UTC");
    const start = Date.now();
    const f = every5.fold(T0, T0 + 70 * 86_400_000, 10_000);
    // GitHub-hosted runners under the capture harness are several times slower than a dev Mac.
    expect(Date.now() - start).toBeLessThan(process.env.CI ? 8_000 : 2_000);
    expect(f.count).toBe(10_000);
    expect(f.latest).toBe(T0 + 70 * 86_400_000);
    expect(f.next).toBe(T0 + 70 * 86_400_000 + 5 * 60_000);
    const hourly = parseSchedule("interval", "PT1H", "UTC");
    expect(hourly.fold(T0, T0 + 1000 * HOUR + 1, 10_000)).toEqual({
      count: 1001,
      latest: T0 + 1000 * HOUR,
      next: T0 + 1001 * HOUR,
    });
  });

  it("re-arms the timer after a failing tick", async () => {
    const errors: unknown[] = [];
    const { scheduler, clock, db } = setup({ start: T0, onError: (e) => errors.push(e) });
    await scheduler.start();
    await scheduler.create({ ...BASE, kind: "interval", schedule: "PT1H" });
    const orig = db.sqlite.transaction.bind(db.sqlite);
    let failures = 1;
    db.sqlite.transaction = ((fn: () => unknown) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("SQLITE_BUSY");
      }
      return orig(fn);
    }) as typeof db.sqlite.transaction;
    clock.advance(5 * 60_000);
    await new Promise((r) => setImmediate(r));
    expect(errors).toHaveLength(1);
    expect(scheduler.armedFor).toBeDefined();
    db.sqlite.transaction = orig;
    scheduler.stop();
  });
});

describe("watch review fixes", () => {
  it("parses whole prices", () => {
    expect(parsePrice("$1234.56")).toBe(1234.56);
    expect(parsePrice("1299")).toBe(1299);
    expect(parsePrice("$1,299.99")).toBe(1299.99);
  });

  it("selectors are literal markers; a missing marker is no observation", async () => {
    const pages = [
      '<div id="status">All good</div>',
      "<html>Please accept cookies</html>", // marker missing: no alert
      '<div id="status">All good</div>',
      '<div id="status">Outage</div>', // change
      '<div id="status">All good</div>', // change back
      '<div id="status">Outage</div>', // and again: alerts again
    ];
    let i = 0;
    const ctx = setup({
      start: T0,
      timers: asleep,
      watchFetch: async () => ({ status: 200, text: pages[i++] as string }),
    });
    await ctx.scheduler.create({
      ...BASE,
      kind: "watch",
      schedule: "PT1H",
      watch: { url: "https://status.example.com", check: "change", selector: 'id="status">' },
    });
    for (let k = 0; k < pages.length; k += 1) {
      ctx.clock.advance(HOUR);
      await ctx.scheduler.wake();
      await ctx.scheduler.idle();
    }
    expect(await ctx.notifier.list()).toHaveLength(3);
  });

  it("a hung fetch times out and counts as a failure", async () => {
    const ctx = setup({
      start: T0,
      timers: asleep,
      watchTimeoutMs: 20,
      watchFetch: () => new Promise(() => {}),
    });
    const w = await ctx.scheduler.create({
      ...BASE,
      kind: "watch",
      schedule: "PT1H",
      watch: { url: "https://slow.example.com", check: "change" },
    });
    ctx.clock.advance(HOUR);
    await ctx.scheduler.wake();
    await ctx.scheduler.idle();
    expect(ctx.scheduler.runs(w.id).runs[0]).toMatchObject({ status: "failed" });
    expect(ctx.scheduler.runs(w.id).runs[0]?.summary).toContain("timed out");
  });

  it("changing a watch's text or threshold resets its dedupe", async () => {
    const ctx = setup({
      start: T0,
      timers: asleep,
      watchFetch: async () => ({ status: 200, text: "Tickets: on sale. Parking: on sale." }),
    });
    const w = await ctx.scheduler.create({
      ...BASE,
      kind: "watch",
      schedule: "PT1H",
      watch: { url: "https://t.example.com", check: "text_present", text: "Tickets: on sale" },
    });
    ctx.clock.advance(HOUR);
    await ctx.scheduler.wake();
    await ctx.scheduler.idle();
    await ctx.scheduler.update(w.id, {
      watch: { url: "https://t.example.com", check: "text_present", text: "Parking: on sale" },
    });
    ctx.clock.advance(HOUR);
    await ctx.scheduler.wake();
    await ctx.scheduler.idle();
    expect(await ctx.notifier.list()).toHaveLength(2);
  });
});
