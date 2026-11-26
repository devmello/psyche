import { describe, expect, it } from "vitest";
import { createAutomationHandlers } from "../src/handlers.ts";
import { asleep, BASE, setup } from "./helpers.ts";

/** Every way a run starts carries the stored taint; a clean automation stays clean. */

const T0 = Date.parse("2026-11-25T09:00:00Z");
const WEB = [{ sourceKind: "web.fetch", origin: "https://example.com/post" }];
const OVERLOADED = `529 {"type":"error","error":{"type":"overloaded_error"}}`;
const CRON = { ...BASE, kind: "cron" as const, schedule: "0 8 * * *" };

describe("every run path starts tainted", () => {
  it("a manual run carries the full sources; the automation handed over shows only kinds", async () => {
    const { scheduler, launcher } = setup({ start: T0, timers: asleep });
    const a = await scheduler.create({ ...CRON, taintSources: WEB });
    await scheduler.runNow(a.id);
    await scheduler.idle();
    expect(launcher.requests[0]?.taintSources).toEqual(WEB);
    expect(launcher.requests[0]?.automation.taintSources).toEqual([{ sourceKind: "web.fetch" }]);
  });

  it("a retry after a transient failure is tainted too", async () => {
    const { scheduler, launcher, clock } = setup({ start: T0, random: () => 0 });
    await scheduler.start();
    await scheduler.create({ ...BASE, kind: "interval", schedule: "PT1H", taintSources: WEB });
    let n = 0;
    launcher.respond = () =>
      n++ === 0
        ? { status: "failed", summary: OVERLOADED, noSideEffects: true }
        : { status: "done", summary: "ok" };
    clock.advance(3_600_000);
    await scheduler.wake();
    await scheduler.idle();
    clock.advance(60_000);
    await scheduler.idle();
    expect(launcher.requests).toHaveLength(2);
    for (const r of launcher.requests) expect(r.taintSources).toEqual(WEB);
    scheduler.stop();
  });

  it("an owner edit of the prompt, title, schedule or zone keeps the taint", async () => {
    const { scheduler, launcher } = setup({ start: T0, timers: asleep });
    const a = await scheduler.create({ ...CRON, taintSources: WEB });
    await scheduler.update(a.id, {
      prompt: "Something else",
      title: "T",
      schedule: "0 9 * * *",
      timezone: "UTC",
    });
    await scheduler.runNow(a.id);
    await scheduler.idle();
    expect(launcher.requests[0]?.taintSources).toEqual(WEB);
  });

  it("a tainted event automation still merges the event's taint", async () => {
    const { scheduler, launcher } = setup({ start: T0, timers: asleep });
    await scheduler.create({
      ...BASE,
      kind: "event",
      schedule: "",
      trigger: { type: "event", source: "mail.received", debounceMs: 0 },
      taintSources: WEB,
    });
    await scheduler.publishEvent({
      id: "mail:work:m1",
      source: "mail.received",
      at: new Date(T0).toISOString(),
      account: "work",
      messageId: "m1",
      threadId: "t1",
      from: "a@b.example",
      subject: "hi",
    });
    await scheduler.flushEvents();
    await scheduler.idle();
    expect(launcher.requests[0]?.taintSources).toEqual([
      ...WEB,
      { sourceKind: "email", sender: "a@b.example" },
    ]);
  });

  it.each(["not json", "{}", "[]", "[{}]", '[{"sourceKind":5}]'])(
    "a damaged stored value (%s) runs tainted as `stored`",
    async (bad) => {
      const { scheduler, launcher, db } = setup({ start: T0, timers: asleep });
      const a = await scheduler.create({ ...CRON, taintSources: WEB });
      // The column's CHECK allows only arrays, so a damaged value is written past it.
      db.sqlite.pragma("ignore_check_constraints = 1");
      db.sqlite.prepare("UPDATE automations SET taint_sources = ? WHERE id = ?").run(bad, a.id);
      await scheduler.runNow(a.id);
      await scheduler.idle();
      expect(launcher.requests[0]?.taintSources).toEqual([{ sourceKind: "stored" }]);
    },
  );
});

describe("stays clean", () => {
  it("a clean schedule, an owner create and a pre-existing NULL row run clean", async () => {
    const { scheduler, launcher, db } = setup({ start: T0, timers: asleep });
    const handlers = createAutomationHandlers(scheduler);
    const { automation } = await handlers["automations.create"]({
      kind: "cron",
      title: "Mine",
      schedule: "0 8 * * *",
      prompt: "Do the thing",
    } as never);
    const old = await scheduler.create(CRON);
    db.sqlite.prepare("UPDATE automations SET taint_sources = NULL WHERE id = ?").run(old.id);
    for (const id of [automation.id, old.id]) {
      await scheduler.runNow(id);
      await scheduler.idle();
    }
    expect(launcher.requests).toHaveLength(2);
    for (const r of launcher.requests) expect(r.taintSources).toBeUndefined();
    expect(automation.taintSources).toBeUndefined();
  });

  it("an owner's schedule, timezone and title updates add no taint", async () => {
    const { scheduler, launcher } = setup({ start: T0, timers: asleep });
    const a = await scheduler.create(CRON);
    await scheduler.update(a.id, { title: "T", schedule: "0 9 * * *", timezone: "UTC" });
    await scheduler.runNow(a.id);
    await scheduler.idle();
    expect(launcher.requests[0]?.taintSources).toBeUndefined();
  });
});

describe("automations.create and reserved job markers", () => {
  const make = (prompt: string) => {
    const { scheduler } = setup({ start: T0, timers: asleep });
    return createAutomationHandlers(scheduler)["automations.create"]({
      kind: "cron",
      title: "x",
      schedule: "0 8 * * *",
      prompt,
    } as never);
  };
  it.each([
    "[psyche:feed-brief daily]\nanything",
    "  [PSYCHE:goal-checkin g1]",
    "@psyche/memory:dreaming",
    "@psyche/teaching:weekly",
  ])("refuses %j", async (prompt) => {
    await expect(make(prompt)).rejects.toMatchObject({ code: "invalid_params" });
  });
  it("accepts the same text when it is not the first thing in the prompt", async () => {
    await expect(make("Remind me about [psyche:x y] later")).resolves.toBeDefined();
  });
});
