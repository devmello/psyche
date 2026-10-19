import { createThread } from "@psyche/db";
import {
  AutomationRun,
  type IssuedApproval,
  validateEventPayload,
  validateResult,
} from "@psyche/protocol";
import { SqliteTaskEngine, TaskWorkerPool } from "@psyche/tasks";
import { FakeAgentLoop, FakeClock, FakePermissionBroker } from "@psyche/testing";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  createAutomationHandlers,
  createTaskLauncher,
  NO_REPLY,
  type SchedulerEvent,
} from "../src/index.ts";
import { asleep, BASE, clockTimers, setup } from "./helpers.ts";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-19T12:00:00Z");

describe("catch-up after sleep", () => {
  it("coalesces 5 missed ticks into 1 run with one host timer", async () => {
    const { scheduler, clock, launcher, db } = setup({ start: T0, timers: asleep });
    await scheduler.start();
    const a = await scheduler.create({ ...BASE, kind: "interval", schedule: "PT1H" });
    expect(a.nextRunAt).toBe(new Date(T0 + HOUR).toISOString());
    // The laptop sleeps through five scheduled runs; no timer fires.
    clock.advance(5 * HOUR + 10 * 60_000);
    const fired = await scheduler.wake();
    await scheduler.idle();
    expect(fired).toEqual([
      { automationId: a.id, scheduledFor: T0 + 5 * HOUR, coalesced: 5, trigger: "schedule" },
    ]);
    expect(launcher.requests).toHaveLength(1);
    expect(launcher.requests[0]?.prompt).toContain("stands for 5 scheduled runs");
    // The next run keeps the hourly phase and is in the future.
    expect((await scheduler.get(a.id))?.nextRunAt).toBe(new Date(T0 + 6 * HOUR).toISOString());
    const runs = db.sqlite.prepare("SELECT status, coalesced FROM automation_runs").all();
    expect(runs).toEqual([{ status: "done", coalesced: 5 }]);
    expect(await scheduler.wake()).toEqual([]);
  });

  it("while awake the single timer fires each tick on time", async () => {
    const { scheduler, clock, launcher } = setup({ start: T0 });
    await scheduler.start();
    const a = await scheduler.create({ ...BASE, kind: "interval", schedule: "PT1H" });
    expect(scheduler.armedFor).toBe(T0 + 5 * 60_000); // capped at maxTimerMs (5 min)
    for (let i = 0; i < 3 * 12; i += 1) {
      clock.advance(5 * 60_000);
      await scheduler.idle();
    }
    expect(launcher.requests.map((r) => r.run.coalesced)).toEqual([1, 1, 1]);
    void a;
    scheduler.stop();
  });

  it('O1: "every weekday at 7, send me my brief on Telegram" works after a laptop sleep', async () => {
    // Monday 2026-10-19, 06:00 in London (BST): the laptop sleeps until 09:12.
    const { scheduler, clock, channelSends } = setup({
      start: Date.parse("2026-10-19T05:00:00Z"),
      timers: asleep,
    });
    await scheduler.start();
    const brief = await scheduler.create({
      ...BASE,
      kind: "briefing",
      title: "Morning brief",
      prompt: "My calendar, inbox triage and two things in robotics",
      schedule: "0 7 * * 1-5",
      timezone: "Europe/London",
      delivery: { channel: "chn_telegram" },
    });
    expect(brief.nextRunAt).toBe("2026-10-19T06:00:00.000Z");
    clock.set(Date.parse("2026-10-19T08:12:00Z"));
    expect(await scheduler.wake()).toHaveLength(1);
    await scheduler.idle();
    expect(channelSends).toEqual([{ channelId: "chn_telegram", text: "Result of Morning brief" }]);
    expect((await scheduler.get(brief.id))?.nextRunAt).toBe("2026-10-20T06:00:00.000Z");
  });

  it("a run whose previous run is still going is recorded as skipped", async () => {
    const { scheduler, clock, launcher } = setup({ start: T0, timers: asleep });
    let release!: () => void;
    launcher.respond = () =>
      new Promise((r) => {
        release = () => r({ status: "done", summary: "ok" });
      });
    await scheduler.start();
    const a = await scheduler.create({ ...BASE, kind: "interval", schedule: "PT1H" });
    clock.advance(HOUR);
    await scheduler.tick();
    clock.advance(HOUR);
    expect(await scheduler.tick()).toEqual([]);
    release();
    await scheduler.idle();
    const { runs } = scheduler.runs(a.id);
    expect(runs.map((r) => r.status)).toEqual(["skipped", "done"]);
  });

  it("a one-shot reminder fires once", async () => {
    const { scheduler, clock, launcher } = setup({ start: T0, timers: asleep });
    await scheduler.start();
    const r = await scheduler.create({
      ...BASE,
      kind: "reminder",
      title: "Call the dentist",
      schedule: new Date(T0 + HOUR).toISOString(),
    });
    clock.advance(3 * HOUR);
    await scheduler.wake();
    await scheduler.wake();
    await scheduler.idle();
    expect(launcher.requests).toHaveLength(1);
    expect((await scheduler.get(r.id))?.nextRunAt).toBeNull();
  });
});

describe("runs", () => {
  it("passes the unattended-run contract and the scratch note; NO_REPLY delivers nothing", async () => {
    const { scheduler, launcher, channelSends, notifier } = setup({ start: T0, timers: asleep });
    launcher.respond = () => ({ status: "no_reply", summary: null });
    const a = await scheduler.create({
      ...BASE,
      kind: "cron",
      schedule: "0 * * * *",
      scratch: "Last run: 3 unread from Alice",
      delivery: { channel: "chn_1" },
    });
    await scheduler.trigger(a.id);
    await scheduler.idle();
    const prompt = launcher.requests[0]?.prompt ?? "";
    expect(prompt).toContain("Nobody is present to answer questions or approve actions");
    expect(prompt).toContain(`reply exactly ${NO_REPLY}`);
    expect(prompt).toContain("deferred into the approvals queue");
    expect(prompt).toContain("Last run: 3 unread from Alice");
    expect(prompt.endsWith("Triage my inbox")).toBe(true);
    expect(channelSends).toEqual([]);
    expect(await notifier.list()).toEqual([]);
    expect(scheduler.runs(a.id).runs[0]?.status).toBe("no_reply");
  });

  it("session targets: isolated gets a new thread per run, named reuses one, main uses main", async () => {
    const { scheduler, launcher, db } = setup({ start: T0, timers: asleep });
    const main = createThread(db, { kind: "main", sessionKey: "main" });
    const iso = await scheduler.create({ ...BASE, kind: "cron", schedule: "0 * * * *" });
    const named = await scheduler.create({
      ...BASE,
      kind: "cron",
      schedule: "0 * * * *",
      sessionTarget: "named:research",
    });
    const onMain = await scheduler.create({
      ...BASE,
      kind: "cron",
      schedule: "0 * * * *",
      sessionTarget: "main",
    });
    for (const a of [iso, iso, named, named, onMain]) {
      await scheduler.trigger(a.id);
      await scheduler.idle();
    }
    const threads = launcher.requests.map((r) => r.threadId);
    expect(threads[0]).not.toBe(threads[1]);
    expect(threads[2]).toBe(threads[3]);
    expect(threads[4]).toBe(main.id);
    const kinds = db.sqlite
      .prepare("SELECT kind, session_key FROM threads WHERE id = ?")
      .get(threads[0]) as { kind: string; session_key: string };
    expect(kinds.kind).toBe("automation");
    expect(kinds.session_key).toMatch(new RegExp(`^cron:${iso.id}:`));
    await expect(
      scheduler.create({ ...BASE, kind: "cron", schedule: "0 * * * *", sessionTarget: "current" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("runs end to end as an unattended Task on the worker pool", async () => {
    const { scheduler, clock, db, channelSends } = setup({ start: T0, timers: asleep });
    const engine = new SqliteTaskEngine({ db, clock });
    const loop = FakeAgentLoop.script([
      [
        { type: "chat.delta", messageId: "m1", delta: "3 meetings today." },
        { type: "end", outcome: "final" },
      ],
    ]);
    const pool = new TaskWorkerPool({ engine, loop, clock, timers: clockTimers(clock) });
    const real = setup({
      start: T0,
      db,
      timers: asleep,
      launcher: createTaskLauncher({ engine, pool }),
    });
    void scheduler;
    void channelSends;
    const a = await real.scheduler.create({
      ...BASE,
      kind: "briefing",
      title: "Brief",
      schedule: "0 7 * * *",
      delivery: { channel: "chn_tg" },
    });
    const { taskId } = await real.scheduler.trigger(a.id);
    expect(taskId).not.toBeNull();
    const task = await engine.get(taskId as string);
    expect(task?.createdFrom).toBe("automation");
    expect(engine.getRecord(taskId as string)?.runMode).toBe("unattended");
    await pool.runOnce();
    expect(loop.turns[0]?.mode).toBe("unattended");
    await real.scheduler.idle();
    const run = real.scheduler.runs(a.id).runs[0];
    expect(run?.status).toBe("done");
    expect(run?.taskId).toBe(taskId);
    expect(Value.Check(AutomationRun, run)).toBe(true);
    expect(real.channelSends).toEqual([{ channelId: "chn_tg", text: "3 meetings today." }]);
  });

  it("a failed run notifies once and is in the history", async () => {
    const { scheduler, launcher, notifier } = setup({ start: T0, timers: asleep });
    launcher.respond = () => ({ status: "failed", summary: "model unavailable" });
    const a = await scheduler.create({ ...BASE, kind: "cron", schedule: "0 * * * *" });
    await scheduler.trigger(a.id);
    await scheduler.idle();
    expect((await notifier.list()).map((n) => [n.kind, n.body])).toEqual([
      ["task_failed", "model unavailable"],
    ]);
    expect((await scheduler.get(a.id))?.lastStatus).toBe("failed");
  });

  it("re-follows a run left running by a restart", async () => {
    const { scheduler, db, clock } = setup({ start: T0, timers: asleep });
    const engine = new SqliteTaskEngine({ db, clock });
    const launcher = createTaskLauncher({ engine });
    const first = setup({ start: T0, db, timers: asleep, launcher });
    const a = await first.scheduler.create({ ...BASE, kind: "cron", schedule: "0 * * * *" });
    const { taskId } = await first.scheduler.trigger(a.id);
    // The Gateway restarts; a new scheduler starts on the same database.
    const second = setup({
      start: T0,
      db,
      timers: asleep,
      launcher: createTaskLauncher({ engine }),
    });
    await second.scheduler.start();
    const lease = await engine.claim("w", { leaseMs: 1000 });
    expect(lease?.taskId).toBe(taskId);
    await engine.updateStatus(taskId as string, "done", { summary: "ok" });
    await second.scheduler.idle();
    expect(second.scheduler.runs(a.id).runs[0]?.status).toBe("done");
    void scheduler;
  });
});

describe("heartbeat", () => {
  it("is one system automation inside active hours with a light context", async () => {
    const { scheduler } = setup({ start: Date.parse("2026-10-19T21:45:00Z"), timers: asleep });
    const hb = await scheduler.ensureHeartbeat({
      everyMinutes: 30,
      activeHours: { start: 8, end: 22 },
      timezone: "UTC",
    });
    expect(hb.kind).toBe("heartbeat");
    expect(hb.sessionTarget).toBe("main");
    expect(hb.lightContext).toBe(true);
    expect(hb.schedule).toBe("0,30 8-21 * * *");
    // 21:45 → the next check-in is 08:00 the next day (21:30 was the last of the day).
    expect(hb.nextRunAt).toBe("2026-10-20T08:00:00.000Z");
    const again = await scheduler.ensureHeartbeat({ everyMinutes: 60, timezone: "UTC" });
    expect(again.id).toBe(hb.id);
    expect(again.schedule).toBe("0 8-21 * * *");
    expect(await scheduler.list({ kind: "heartbeat" })).toHaveLength(1);
    await expect(
      scheduler.ensureHeartbeat({ activeHours: { start: 9, end: 9 } }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("surfaces at most one notification per run, none for NO_REPLY", async () => {
    const { scheduler, launcher, notifier } = setup({ start: T0, timers: asleep });
    const hb = await scheduler.ensureHeartbeat({ timezone: "UTC" });
    launcher.respond = () => ({ status: "done", summary: "Your 3pm moved to 4pm." });
    await scheduler.trigger(hb.id);
    await scheduler.idle();
    launcher.respond = () => ({ status: "no_reply", summary: null });
    await scheduler.trigger(hb.id);
    await scheduler.idle();
    expect(launcher.requests.every((r) => r.lightContext)).toBe(true);
    expect((await notifier.list()).map((n) => [n.kind, n.body])).toEqual([
      ["proactive", "Your 3pm moved to 4pm."],
    ]);
  });
});

describe("delivery by webhook", () => {
  const run = async (decision: "allow" | "deny") => {
    const posts: string[] = [];
    const broker = FakePermissionBroker.policy({ byTool: { "automation.webhook": decision } });
    const ctx = setup({
      start: T0,
      timers: asleep,
      deliverer: {
        broker,
        webhookFetch: async (url) => {
          posts.push(url);
          return { status: 204 };
        },
      },
    });
    const a = await ctx.scheduler.create({
      ...BASE,
      kind: "cron",
      schedule: "0 * * * *",
      delivery: { webhook: "https://hooks.example.com/psyche" },
    });
    await ctx.scheduler.trigger(a.id);
    await ctx.scheduler.idle();
    return { ...ctx, posts, broker };
  };

  it("is a tainted, unattended destructive send: queued, then POSTed once approved, with a receipt", async () => {
    const posts: string[] = [];
    const clock = new FakeClock(T0);
    const broker = new FakePermissionBroker({
      clock,
      policy: { byTool: { "automation.webhook": "allow" } },
    });
    const queued: IssuedApproval[] = [];
    const ctx = setup({
      start: T0,
      timers: asleep,
      deliverer: {
        broker,
        onApprovalQueued: (i) => queued.push(i),
        webhookFetch: async (url) => {
          posts.push(url);
          return { status: 204 };
        },
      },
    });
    const a = await ctx.scheduler.create({
      ...BASE,
      kind: "cron",
      schedule: "0 * * * *",
      delivery: { webhook: "https://hooks.example.com/psyche" },
    });
    await ctx.scheduler.trigger(a.id);
    await ctx.scheduler.idle();
    const decided = broker.decisions[0];
    expect(decided?.call).toMatchObject({
      tool: "automation.webhook",
      sideEffect: "destructive",
      target: { kind: "origin", value: "https://hooks.example.com" },
    });
    expect(decided?.ctx).toMatchObject({ unattended: true, taint: true });
    // Destructive sends always ask; nothing is posted until the owner approves.
    expect(posts).toEqual([]);
    const issued = queued[0];
    if (issued === undefined) throw new Error("no approval queued");
    clock.advance(1_000);
    await broker.answer({
      approvalId: issued.approval.id,
      answerToken: issued.answerTokens.desktop as string,
      decision: "approve",
      scope: "once",
      decidedBy: { kind: "device", deviceId: "dev_1" },
    } as Parameters<typeof broker.answer>[0]);
    for (let k = 0; k < 10; k += 1) await new Promise((r) => setImmediate(r));
    expect(posts).toEqual(["https://hooks.example.com/psyche"]);
    expect((await broker.listReceipts()).map((r) => [r.kind, r.outcome, r.approvalId])).toEqual([
      ["webhook.post", "ok", issued.approval.id],
    ]);
  });

  it("an ask is queued as a bound approval instead of being sent or dropped", async () => {
    const posts: string[] = [];
    const broker = FakePermissionBroker.policy({ byTool: { "automation.webhook": "ask" } });
    const ctx = setup({
      start: T0,
      timers: asleep,
      deliverer: {
        broker,
        webhookFetch: async (url, init) => {
          expect(init.redirect).toBe("error");
          posts.push(url);
          return { status: 200 };
        },
      },
    });
    const a = await ctx.scheduler.create({
      ...BASE,
      kind: "cron",
      schedule: "0 * * * *",
      delivery: { webhook: "https://hooks.example.com/psyche" },
    });
    await ctx.scheduler.trigger(a.id);
    await ctx.scheduler.idle();
    expect(posts).toEqual([]);
    const [pending] = await broker.list({ status: "pending" });
    expect(pending).toMatchObject({
      sideEffect: "destructive",
      taint: true,
      target: { kind: "origin", value: "https://hooks.example.com" },
    });
    expect(pending?.bindingHash).toMatch(/^sha256:/);
    expect(ctx.scheduler.runs(a.id).runs[0]?.status).toBe("done");
  });

  it("is not sent when the broker does not allow it", async () => {
    const { posts, notifier } = await run("deny");
    expect(posts).toEqual([]);
    expect((await notifier.list())[0]?.title).toContain("webhook not sent");
  });

  it("must be https without credentials", async () => {
    const { scheduler } = setup({ start: T0, timers: asleep });
    for (const webhook of [
      "http://hooks.example.com/",
      "https://u:p@hooks.example.com/",
      "https://127.0.0.1/hook",
      "https://localhost:8443/hook",
      "https://192.168.1.10/hook",
      "https://[::1]/hook",
      "https://nas.local/hook",
    ]) {
      await expect(
        scheduler.create({ ...BASE, kind: "cron", schedule: "0 * * * *", delivery: { webhook } }),
      ).rejects.toMatchObject({ code: "invalid_params" });
    }
  });
});

describe("Upcoming, events and handlers", () => {
  it("lists everything scheduled, soonest first, then open input requests", async () => {
    const { scheduler } = setup({
      start: T0,
      timers: asleep,
      openInputRequests: () => [
        {
          id: "inp_1",
          taskId: "task_1",
          threadId: "thr_1",
          questions: [
            {
              question: "Which flight?",
              header: "Flight",
              options: [{ label: "AM" }, { label: "PM" }],
              multiSelect: false,
            },
          ],
          status: "open",
          answer: null,
          createdAt: new Date(T0).toISOString(),
          answeredAt: null,
          answeredByDeviceId: null,
        },
      ],
    });
    await scheduler.create({ ...BASE, kind: "cron", title: "Daily", schedule: "0 18 * * *" });
    await scheduler.create({
      ...BASE,
      kind: "reminder",
      title: "Dentist",
      schedule: new Date(T0 + HOUR).toISOString(),
    });
    await scheduler.create({
      ...BASE,
      kind: "cron",
      title: "Off",
      schedule: "0 * * * *",
      enabled: false,
    });
    const h = createAutomationHandlers(scheduler);
    const res = await h["automations.upcoming"]({});
    validateResult("automations.upcoming", res);
    expect(res.items.map((i) => [i.kind, i.title])).toEqual([
      ["reminder", "Dentist"],
      ["automation", "Daily"],
      ["input_request", "Which flight?"],
    ]);
  });

  it("emits automation.* events with stateVersion and valid payloads", async () => {
    const { scheduler } = setup({
      start: T0,
      timers: asleep,
      nextStateVersion: (() => {
        let v = 0;
        return () => ++v;
      })(),
    });
    const events: SchedulerEvent[] = [];
    scheduler.subscribe((e) => events.push(e));
    const a = await scheduler.create({ ...BASE, kind: "cron", schedule: "0 * * * *" });
    await scheduler.trigger(a.id);
    await scheduler.idle();
    expect(events.map((e) => e.event)).toEqual([
      "automation.updated",
      "automation.run.started",
      "automation.updated",
      "automation.run.finished",
      "automation.updated",
    ]);
    expect(events.map((e) => e.stateVersion)).toEqual([1, 2, 3, 4, 5]);
    for (const e of events) validateEventPayload(e.event, e.payload);
  });

  it("automations.* handlers create, pause, run, page history and delete", async () => {
    const { scheduler } = setup({ start: T0, timers: asleep });
    const h = createAutomationHandlers(scheduler);
    const { automation } = await h["automations.create"]({
      kind: "interval",
      title: "Check status page",
      schedule: "PT30M",
      prompt: "Check the status page",
    });
    validateResult("automations.create", { automation });
    expect(automation.sessionTarget).toBe("isolated");
    const paused = await h["automations.update"]({ automationId: automation.id, enabled: false });
    expect(paused.automation.nextRunAt).toBeNull();
    const resumed = await h["automations.update"]({ automationId: automation.id, enabled: true });
    expect(resumed.automation.nextRunAt).not.toBeNull();
    for (let i = 0; i < 3; i += 1) {
      await h["automations.run"]({ automationId: automation.id });
      await scheduler.idle();
    }
    const p1 = await h["automations.runs"]({ automationId: automation.id, limit: 2 });
    validateResult("automations.runs", p1);
    const p2 = await h["automations.runs"]({
      automationId: automation.id,
      limit: 2,
      cursor: p1.nextCursor ?? "",
    });
    expect(p1.runs.length + p2.runs.length).toBe(3);
    expect(p2.nextCursor).toBeNull();
    expect((await h["automations.list"]({})).automations).toHaveLength(1);
    await h["automations.delete"]({ automationId: automation.id });
    expect((await h["automations.list"]({})).automations).toHaveLength(0);
  });
});
