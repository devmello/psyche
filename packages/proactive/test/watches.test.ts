import { createDbSessionResolver, SqliteScheduler } from "@psyche/scheduler";
import { createIdGenerator, FakeClock, FakeNotifier, FakeTaskEngine } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { GoalsService, withProactiveJobs } from "../src/index.ts";
import { asleep, RecordingLauncher, T0, testDb } from "./helpers.ts";

/** A registration page whose price the test moves; fetches are recorded. */
function page() {
  const state = { price: "$120", status: 200, fetches: 0 };
  const fetch = async () => {
    state.fetches += 1;
    return {
      status: state.status,
      text: `<h1>Half marathon</h1><p>Registration fee: ${state.price}</p>`,
    };
  };
  return { state, fetch };
}

function rig() {
  const clock = new FakeClock(T0);
  const db = testDb(clock);
  const notifier = new FakeNotifier({ clock });
  const agent = new RecordingLauncher();
  const ids = createIdGenerator({ prefix: "s" });
  const site = page();
  let goals: GoalsService | null = null;
  const scheduler = new SqliteScheduler({
    db,
    clock,
    timers: asleep,
    newId: () => ids.next(),
    launcher: withProactiveJobs(agent, {
      get jobs() {
        return goals === null ? [] : [goals.checkinJob()];
      },
    }),
    sessions: createDbSessionResolver(db),
    notifier,
    watchFetch: site.fetch,
  });
  goals = new GoalsService({
    db: db.sqlite,
    clock,
    scheduler,
    notifier,
    tasks: new FakeTaskEngine({ clock }),
    timezone: "UTC",
  });
  return { clock, notifier, agent, scheduler, goals, site };
}

describe("goal watches (O3)", () => {
  it("a price drop produces one alert; it re-arms after the price goes back up", async () => {
    const { goals, scheduler, notifier, site, agent } = rig();
    const { goal } = await goals.create({
      title: "Run a half marathon in May",
      category: "health",
    });
    const { automation, detail } = await goals.addWatch(goal.id, {
      url: "https://race.example/register",
      check: "price_below",
      selector: "Registration fee:",
      threshold: 100,
    });
    expect(automation).toMatchObject({ kind: "watch", schedule: "PT6H", enabled: true });
    expect(detail.links).toEqual([
      { goalId: goal.id, taskId: null, automationId: null, watchId: automation.id },
    ]);
    const check = async (price: string) => {
      site.state.price = price;
      await scheduler.trigger(automation.id);
      await scheduler.idle();
    };
    await check("$120");
    await check("$95");
    await check("$90");
    await check("$89");
    expect((await notifier.list()).map((n) => [n.kind, n.body])).toEqual([
      ["proactive", "Price 95 is at or below 100: https://race.example/register"],
    ]);
    await check("$110");
    await check("$95");
    expect((await notifier.list()).filter((n) => n.kind === "proactive")).toHaveLength(2);
    expect(agent.requests).toEqual([]);
    const progress = await goals.progress(goal.id);
    expect(progress.watches).toEqual([
      expect.objectContaining({
        automationId: automation.id,
        url: "https://race.example/register",
        check: "price_below",
        enabled: true,
        lastStatus: "done",
        missing: false,
      }),
    ]);
  });

  it("failures back off and do not alert", async () => {
    const { goals, scheduler, notifier, site } = rig();
    const { goal } = await goals.create({ title: "Get race shoes", category: "health" });
    const { automation } = await goals.addWatch(goal.id, {
      url: "https://shop.example/shoe",
      check: "text_present",
      text: "In stock",
      every: "PT1H",
    });
    site.state.status = 503;
    await scheduler.trigger(automation.id);
    await scheduler.idle();
    await scheduler.trigger(automation.id);
    await scheduler.idle();
    const a = await scheduler.get(automation.id);
    // 1 h × 2^2 after two failures in a row.
    expect(Date.parse(a?.nextRunAt ?? "") - T0).toBe(4 * 3_600_000);
    // The scheduler reports each failed check as task_failed with one dedupe key: one row.
    expect((await notifier.list()).filter((n) => n.kind === "proactive")).toEqual([]);
  });

  it("watches run only while the goal is active; removing unlinks and deletes", async () => {
    const { goals, scheduler } = rig();
    const { goal } = await goals.create({ title: "Visit Lisbon", category: "other" });
    const { automation } = await goals.addWatch(goal.id, {
      url: "https://air.example/lis",
      check: "change",
    });
    await goals.update(goal.id, { status: "paused" });
    expect((await scheduler.get(automation.id))?.enabled).toBe(false);
    await goals.update(goal.id, { status: "active" });
    expect((await scheduler.get(automation.id))?.enabled).toBe(true);
    await goals.archive(goal.id);
    expect((await scheduler.get(automation.id))?.enabled).toBe(false);

    const second = await goals.create({ title: "Visit Porto", category: "other" });
    const w = await goals.addWatch(second.goal.id, {
      url: "https://air.example/opo",
      check: "change",
    });
    const after = await goals.removeWatch(second.goal.id, w.automation.id);
    expect(after.links).toEqual([]);
    expect(await scheduler.get(w.automation.id)).toBeUndefined();
    await expect(goals.removeWatch(second.goal.id, w.automation.id)).rejects.toMatchObject({
      code: "not_found",
    });
    // A watch deleted elsewhere shows as missing on the goal page.
    const third = await goals.addWatch(second.goal.id, {
      url: "https://air.example/fao",
      check: "change",
    });
    await scheduler.remove(third.automation.id);
    expect((await goals.progress(second.goal.id)).watches[0]).toMatchObject({ missing: true });
    // Candidates cannot get watches before confirm.
    const candidate = await goals.propose({
      title: "Run more",
      category: "health",
      evidence: [{ kind: "note" }],
    });
    await expect(
      goals.addWatch(candidate?.id ?? "", { url: "https://x.example", check: "change" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
