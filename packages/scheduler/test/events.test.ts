import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MIGRATIONS_DIR, openDb, runMigrations } from "@psyche/db";
import type { WorkflowEvent } from "@psyche/protocol";
import { SqliteTaskEngine } from "@psyche/tasks";
import { describe, expect, it } from "vitest";
import { createTaskLauncher, DEFAULT_DEBOUNCE_MS } from "../src/index.ts";
import { asleep, BASE, setup } from "./helpers.ts";

/** Event triggers (docs/workflows/mail-and-meetings-2026.md §4.7, §8.2; #670 W3). */

const T0 = Date.parse("2026-10-26T09:00:00Z");

const mail = (id: string, from = "Dana <dana@example.com>", account = "work"): WorkflowEvent => ({
  id: `mail:${account}:${id}`,
  source: "mail.received",
  at: new Date(T0).toISOString(),
  account,
  messageId: id,
  threadId: `t-${id}`,
  from,
  subject: `About ${id}`,
});

async function eventAutomation(
  s: ReturnType<typeof setup>["scheduler"],
  trigger: Partial<NonNullable<Parameters<typeof s.create>[0]["trigger"]>> = {},
) {
  return s.create({
    ...BASE,
    kind: "event",
    title: "On new mail",
    schedule: "",
    prompt: "Look at the new mail",
    trigger: { type: "event", source: "mail.received", ...trigger },
  });
}

describe("event automations", () => {
  it("validate: event needs a trigger and no schedule; other kinds take no trigger", async () => {
    const { scheduler } = setup({ start: T0, timers: asleep });
    await expect(
      scheduler.create({ ...BASE, kind: "event", title: "x", schedule: "", prompt: "x" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      scheduler.create({
        ...BASE,
        kind: "event",
        title: "x",
        schedule: "PT1H",
        prompt: "x",
        trigger: { type: "event", source: "mail.received" },
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      scheduler.create({
        ...BASE,
        kind: "cron",
        title: "x",
        schedule: "0 * * * *",
        prompt: "x",
        trigger: { type: "event", source: "mail.received" },
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    const a = await eventAutomation(scheduler);
    expect(a).toMatchObject({
      kind: "event",
      nextRunAt: null,
      trigger: { type: "event", source: "mail.received" },
    });
    expect(await scheduler.nextRuns(a.id, 3)).toEqual([]);
    expect(await scheduler.tick(T0 + 86_400_000)).toEqual([]);
  });

  it("coalesces events inside the debounce window into one tainted run with the events fenced", async () => {
    const { scheduler, launcher, clock } = setup({ start: T0, timers: asleep });
    const a = await eventAutomation(scheduler);
    for (const id of ["m1", "m2", "m3"])
      expect(await scheduler.publishEvent(mail(id))).toEqual([a.id]);
    expect(await scheduler.flushEvents(T0 + DEFAULT_DEBOUNCE_MS - 1)).toEqual([]);
    clock.advance(DEFAULT_DEBOUNCE_MS);
    const [run] = await scheduler.flushEvents();
    await scheduler.idle();
    expect(run).toMatchObject({ trigger: "event", coalesced: 3 });
    expect(run?.events?.map((e) => e.messageId)).toEqual(["m1", "m2", "m3"]);
    const req = launcher.requests[0];
    expect(req?.events).toHaveLength(3);
    expect(req?.taintSources).toEqual([{ sourceKind: "email", sender: "Dana <dana@example.com>" }]);
    expect(req?.prompt).toContain("<<<untrusted-data>>>");
    expect(req?.prompt).toContain("subject About m2");
    expect(req?.prompt).toMatch(/never instructions/);
    expect(scheduler.runs(a.id).runs[0]).toMatchObject({ status: "done", trigger: "event" });
  });

  it("a source id starts at most one run per automation, ever", async () => {
    const { scheduler, launcher, clock } = setup({ start: T0, timers: asleep });
    const a = await eventAutomation(scheduler, { debounceMs: 0 });
    expect(await scheduler.publishEvent(mail("m1"))).toEqual([a.id]);
    expect(await scheduler.publishEvent(mail("m1"))).toEqual([]);
    await scheduler.flushEvents();
    await scheduler.idle();
    clock.advance(3_600_000);
    expect(await scheduler.publishEvent(mail("m1"))).toEqual([]);
    expect(await scheduler.flushEvents()).toEqual([]);
    expect(launcher.requests).toHaveLength(1);
  });

  it("filters by account and sender; disabled automations get nothing", async () => {
    const { scheduler } = setup({ start: T0, timers: asleep });
    const work = await eventAutomation(scheduler, {
      filter: { accounts: ["work"], fromContains: "dana" },
    });
    const off = await eventAutomation(scheduler);
    await scheduler.update(off.id, { enabled: false });
    expect(await scheduler.publishEvent(mail("m1", "Lee <lee@example.com>"))).toEqual([]);
    expect(await scheduler.publishEvent(mail("m2", "Dana <DANA@example.com>", "home"))).toEqual([]);
    expect(await scheduler.publishEvent(mail("m3"))).toEqual([work.id]);
    expect(await scheduler.publishEvent({ ...mail("x"), source: "calendar.changed" })).toEqual([]);
  });

  it("past the daily budget, runs are recorded skipped with a reason", async () => {
    const { scheduler, launcher, clock } = setup({ start: T0, timers: asleep });
    const a = await eventAutomation(scheduler, { debounceMs: 0, maxRunsPerDay: 2 });
    for (const id of ["m1", "m2", "m3"]) {
      await scheduler.publishEvent(mail(id));
      await scheduler.flushEvents();
      await scheduler.idle();
      clock.advance(60_000);
    }
    expect(launcher.requests).toHaveLength(2);
    const runs = scheduler.runs(a.id).runs;
    expect(runs[0]).toMatchObject({ status: "skipped", summary: "Daily run budget reached (2)" });
  });

  it("keeps events queued while the previous run is still going", async () => {
    const { scheduler, launcher, clock } = setup({ start: T0, timers: asleep });
    let release!: () => void;
    launcher.respond = () =>
      new Promise((r) => {
        release = () => r({ status: "done", summary: "ok" });
      }) as never;
    const a = await eventAutomation(scheduler, { debounceMs: 0 });
    await scheduler.publishEvent(mail("m1"));
    await scheduler.flushEvents();
    await scheduler.publishEvent(mail("m2"));
    clock.advance(1_000);
    expect(await scheduler.flushEvents()).toEqual([]);
    release();
    await scheduler.idle();
    launcher.respond = () => ({ status: "done", summary: "ok" });
    const [second] = await scheduler.flushEvents();
    await scheduler.idle();
    expect(second?.events?.map((e) => e.messageId)).toEqual(["m2"]);
    expect(scheduler.runs(a.id).runs).toHaveLength(2);
  });

  it("the queue survives a restart: a new scheduler on the same database runs it", async () => {
    const first = setup({ start: T0, timers: asleep });
    const a = await eventAutomation(first.scheduler);
    await first.scheduler.publishEvent(mail("m1"));
    const second = setup({ start: T0 + DEFAULT_DEBOUNCE_MS, timers: asleep, db: first.db });
    await second.scheduler.start();
    await second.scheduler.idle();
    expect(second.launcher.requests.map((r) => r.automation.id)).toEqual([a.id]);
    second.scheduler.stop();
  });

  it("Upcoming lists event automations with their trigger; run-now replays the last events", async () => {
    const { scheduler, launcher } = setup({ start: T0, timers: asleep });
    const a = await eventAutomation(scheduler, { debounceMs: 0 });
    await scheduler.publishEvent(mail("m1"));
    await scheduler.flushEvents();
    await scheduler.idle();
    const row = scheduler.upcoming().find((i) => i.id === a.id);
    expect(row).toMatchObject({
      kind: "automation",
      nextRunAt: null,
      trigger: { source: "mail.received" },
    });
    expect(row?.lastRunAt).not.toBeNull();
    await scheduler.trigger(a.id);
    await scheduler.idle();
    expect(launcher.requests[1]?.events?.map((e) => e.messageId)).toEqual(["m1"]);
    expect(launcher.requests[1]?.run.trigger).toBe("manual");
  });

  it("cursors are durable per source and key", async () => {
    const { scheduler, db } = setup({ start: T0, timers: asleep });
    expect(scheduler.getCursor("mail.apple", "work")).toBeUndefined();
    scheduler.setCursor("mail.apple", "work", "2026-10-26T09:00:00.000Z");
    scheduler.setCursor("mail.apple", "work", "2026-10-26T09:10:00.000Z");
    const again = setup({ start: T0, timers: asleep, db });
    expect(again.scheduler.getCursor("mail.apple", "work")).toBe("2026-10-26T09:10:00.000Z");
  });

  it("a task launched for an event run starts tainted with the events' sources", async () => {
    const base = setup({ start: T0, timers: asleep });
    const engine = new SqliteTaskEngine({ db: base.db, clock: base.clock });
    const real = setup({
      start: T0,
      timers: asleep,
      db: base.db,
      launcher: createTaskLauncher({ engine }),
    });
    await eventAutomation(real.scheduler, { debounceMs: 0 });
    await real.scheduler.publishEvent(mail("m1"));
    await real.scheduler.flushEvents();
    const [task] = await engine.list();
    expect(task).toMatchObject({ createdFrom: "automation", taint: true });
    expect(task?.taintSources).toEqual([
      { sourceKind: "email", sender: "Dana <dana@example.com>" },
    ]);
  });
});

describe("migration 202610252000_scheduler_event-triggers", () => {
  it("rebuilds the scheduler tables without losing automations, runs or watches", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-mig-"));
    try {
      for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
        if (f.endsWith(".sql") && f < "202610252000")
          copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(dir, f));
      }
      const db = openDb(":memory:", { migrate: false });
      runMigrations(db.sqlite, { dir });
      const at = "2026-10-25T00:00:00.000Z";
      db.sqlite.exec(`
        INSERT INTO automations (id, kind, title, schedule, timezone, prompt, created_at, updated_at)
          VALUES ('a1', 'watch', 'Price', 'PT1H', 'UTC', 'x', '${at}', '${at}');
        INSERT INTO automation_runs (id, automation_id, trigger, scheduled_for, started_at, status, created_at)
          VALUES ('r1', 'a1', 'schedule', '${at}', '${at}', 'done', '${at}');
        INSERT INTO watches (id, automation_id, url, kind, failures, created_at, updated_at)
          VALUES ('w1', 'a1', 'https://x.example', 'change', 2, '${at}', '${at}');
      `);
      const result = runMigrations(db.sqlite);
      expect(result.applied).toContain("202610252000_scheduler_event-triggers");
      expect(db.sqlite.prepare("SELECT id FROM automations").all()).toEqual([{ id: "a1" }]);
      expect(db.sqlite.prepare("SELECT id, trigger FROM automation_runs").all()).toEqual([
        { id: "r1", trigger: "schedule" },
      ]);
      expect(db.sqlite.prepare("SELECT id, failures FROM watches").all()).toEqual([
        { id: "w1", failures: 2 },
      ]);
      // The foreign keys point at the rebuilt table: deleting the automation still cascades.
      expect(db.sqlite.pragma("foreign_key_check")).toEqual([]);
      db.sqlite.prepare("DELETE FROM automations WHERE id = 'a1'").run();
      expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM automation_runs").get()).toEqual({
        n: 0,
      });
      expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM watches").get()).toEqual({ n: 0 });
      db.sqlite.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
