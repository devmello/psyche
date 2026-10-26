import { Goal } from "@psyche/protocol";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { createGoalHandlers, jobMarker, PROACTIVITY_BUDGET } from "../src/index.ts";
import { setup } from "./helpers.ts";

describe("stated goals (O9)", () => {
  it("creates an active goal with milestones and a check-in on the real scheduler", async () => {
    const { goals, scheduler, events } = setup();
    const detail = await goals.create({
      title: "Run a half marathon in May",
      category: "health",
      cadence: "0 8 * * 1",
      milestones: [{ title: "5k" }, { title: "10k", dueAt: "2026-12-01T00:00:00Z" }],
    });
    expect(detail.goal).toMatchObject({ status: "active", inferred: false });
    expect(detail.goal.confirmedAt).not.toBeNull();
    expect(detail.milestones.map((m) => m.title)).toEqual(["5k", "10k"]);
    expect(Value.Check(Goal, detail.goal)).toBe(true);
    // Monday 08:00 UTC after 2026-10-19 09:00 (a Monday) is 2026-10-26.
    expect(detail.goal.nextCheckinAt).toBe("2026-10-26T08:00:00.000Z");
    const automations = await scheduler.list();
    expect(automations).toHaveLength(1);
    expect(automations[0]).toMatchObject({
      kind: "cron",
      title: "Check-in: Run a half marathon in May",
      prompt: jobMarker("goal-checkin", detail.goal.id),
      sessionTarget: "main",
      enabled: true,
    });
    expect(events.map((e) => e.event)).toEqual(["goal.updated"]);
  });

  it("rejects a bad cadence and leaves no goal behind", async () => {
    const { goals, scheduler } = setup();
    await expect(
      goals.create({ title: "Sleep 7h", category: "health", cadence: "not a schedule" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    expect(await goals.list({})).toEqual([]);
    expect(await scheduler.list()).toEqual([]);
  });

  it("a check-in run raises one reminder, re-arms, and never starts the agent", async () => {
    const { goals, scheduler, notifier, agent, tasks } = setup();
    const { goal } = await goals.create({
      title: "Emergency fund",
      category: "finance",
      cadence: "PT24H",
      milestones: [{ title: "$1k" }, { title: "$5k" }],
    });
    const task = await tasks.create({
      threadId: "thr_1",
      title: "Move $200",
      goal: "transfer",
      createdFrom: "chat",
    });
    await goals.link({ goalId: goal.id, taskId: task.id });
    await goals.milestone({
      goalId: goal.id,
      milestoneId: (await goals.get(goal.id)).milestones[0]?.id,
      done: true,
    });
    const [checkin] = await scheduler.list();
    await scheduler.trigger(checkin?.id ?? "");
    await scheduler.idle();
    await scheduler.trigger(checkin?.id ?? "");
    await scheduler.idle();
    const notifications = await notifier.list();
    // Two runs, one dedupe key: one row (PROACTIVITY_BUDGET.goals.notificationsPerCheckin).
    expect(notifications).toHaveLength(PROACTIVITY_BUDGET.goals.notificationsPerCheckin);
    expect(notifications[0]).toMatchObject({
      kind: "reminder",
      title: "Check-in: Emergency fund",
      route: `/goals/${goal.id}`,
      // Spoken only on request (voice-mode-2026 §4.9).
      actions: [{ id: "listen", label: "Listen" }],
    });
    expect(notifications[0]?.body).toContain("1/2 milestones done");
    expect(notifications[0]?.body).toContain("next: $5k");
    expect(notifications[0]?.body).toContain("tasks: 1 queued");
    expect(agent.requests).toEqual([]);
    const runs = scheduler.runs(checkin?.id ?? "").runs;
    expect(runs.map((r) => r.status)).toEqual(["no_reply", "no_reply"]);
    // Dismissible: resolving the reminder is all it takes.
    await notifier.resolve(notifications[0]?.id ?? "");
    expect((await notifier.list({ unresolvedOnly: true })).length).toBe(0);
  });

  it("pausing disables the check-in, archiving removes it, done keeps history", async () => {
    const { goals, scheduler } = setup();
    const { goal } = await goals.create({
      title: "Learn Rust",
      category: "learning",
      cadence: "0 9 * * *",
    });
    await goals.update(goal.id, { status: "paused" });
    expect((await scheduler.list())[0]).toMatchObject({ enabled: false });
    expect((await goals.get(goal.id)).goal.nextCheckinAt).toBeNull();
    await goals.update(goal.id, { status: "active", cadence: "PT12H" });
    expect((await scheduler.list())[0]).toMatchObject({ kind: "interval", enabled: true });
    await goals.update(goal.id, { cadence: null });
    expect(await scheduler.list()).toEqual([]);
    await goals.update(goal.id, { cadence: "0 9 * * *" });
    const archived = await goals.archive(goal.id);
    expect(archived).toMatchObject({ status: "archived" });
    expect(archived.archivedAt).not.toBeNull();
    expect(await scheduler.list()).toEqual([]);
    await expect(goals.update(goal.id, { title: "x" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("restart: start() re-creates a lost check-in and drops an orphaned one", async () => {
    const { goals, scheduler } = setup();
    const { goal } = await goals.create({
      title: "Read 12 books",
      category: "learning",
      cadence: "0 20 * * 0",
    });
    const [a] = await scheduler.list();
    await scheduler.remove(a?.id ?? "");
    await scheduler.create({
      kind: "cron",
      title: "Check-in: ghost",
      schedule: "0 1 * * *",
      prompt: jobMarker("goal-checkin", "goal_gone"),
      system: true,
    });
    await goals.start();
    const after = await scheduler.list();
    expect(after).toHaveLength(1);
    expect(after[0]?.prompt).toBe(jobMarker("goal-checkin", goal.id));
    expect((await goals.get(goal.id)).goal.nextCheckinAt).toBe(after[0]?.nextRunAt);
  });

  it("links exactly one of task, automation, watch; unlink removes it", async () => {
    const { goals } = setup();
    const { goal } = await goals.create({ title: "Tidy the garage", category: "home" });
    await expect(goals.link({ goalId: goal.id })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      goals.link({ goalId: goal.id, taskId: "t1", watchId: "w1" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await goals.link({ goalId: goal.id, taskId: "t1" });
    await goals.link({ goalId: goal.id, taskId: "t1" });
    await goals.link({ goalId: goal.id, watchId: "w1" });
    expect((await goals.get(goal.id)).links).toHaveLength(2);
    expect((await goals.get(goal.id)).taskIds).toEqual(["t1"]);
    await goals.link({ goalId: goal.id, taskId: "t1", unlink: true });
    expect((await goals.get(goal.id)).taskIds).toEqual([]);
  });
});

describe("inferred candidates are confirm-first", () => {
  const evidence = [
    { kind: "memory", text: "mentioned running 3 times", ref: "memory/2026-10-01.md" },
  ];

  it("a candidate creates nothing until confirm; confirm activates it", async () => {
    const { goals, scheduler, notifier, agent, tasks } = setup();
    const goal = await goals.propose({
      title: "Run more",
      category: "health",
      evidence,
      source: "memory",
    });
    expect(goal).toMatchObject({ status: "candidate", inferred: true, confirmedAt: null });
    expect(goal?.plan).toMatchObject({ evidence, source: "memory" });
    // Nothing anywhere else: no automation, task, notification or agent run.
    expect(await scheduler.list()).toEqual([]);
    expect(await tasks.list()).toEqual([]);
    expect(await notifier.list()).toEqual([]);
    expect(agent.requests).toEqual([]);
    // Candidates cannot be edited, linked or given milestones.
    await expect(goals.update(goal?.id ?? "", { cadence: "PT1H" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(goals.link({ goalId: goal?.id ?? "", taskId: "t" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(goals.milestone({ goalId: goal?.id ?? "", title: "x" })).rejects.toMatchObject({
      code: "conflict",
    });
    const confirmed = await goals.decide(goal?.id ?? "", "confirm");
    expect(confirmed.status).toBe("active");
    expect(confirmed.confirmedAt).not.toBeNull();
    await expect(goals.decide(goal?.id ?? "", "confirm")).rejects.toMatchObject({
      code: "conflict",
    });
    await goals.update(goal?.id ?? "", { cadence: "PT1H" });
    expect(await scheduler.list()).toHaveLength(1);
  });

  it("reject archives and suppresses the same proposal; later defers", async () => {
    const { goals, clock } = setup();
    const a = await goals.propose({ title: "Learn piano", category: "learning", evidence });
    const deferred = await goals.decide(a?.id ?? "", "later");
    expect(deferred.status).toBe("candidate");
    expect(deferred.plan).toMatchObject({
      deferrals: 1,
      deferredUntil: new Date(clock.now() + 7 * 86_400_000).toISOString(),
    });
    // Proposing again returns the open candidate, not a duplicate.
    expect(
      (await goals.propose({ title: "learn PIANO!", category: "learning", evidence }))?.id,
    ).toBe(a?.id);
    const rejected = await goals.decide(a?.id ?? "", "reject");
    expect(rejected).toMatchObject({ status: "archived", confirmedAt: null });
    expect(
      await goals.propose({ title: "Learn piano", category: "learning", evidence }),
    ).toBeUndefined();
    expect(await goals.list({})).toEqual([]);
    expect((await goals.list({ status: ["archived"] })).map((g) => g.id)).toEqual([a?.id]);
  });

  it("is bounded: no more open candidates than the budget, and evidence is required", async () => {
    const { goals } = setup();
    await expect(
      goals.propose({ title: "No reason", category: "other", evidence: [] }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    for (let i = 0; i < PROACTIVITY_BUDGET.goals.maxOpenCandidates; i += 1) {
      expect(
        await goals.propose({ title: `Candidate ${i}`, category: "other", evidence }),
      ).toBeDefined();
    }
    expect(
      await goals.propose({ title: "One too many", category: "other", evidence }),
    ).toBeUndefined();
    expect(await goals.list({ status: ["candidate"] })).toHaveLength(
      PROACTIVITY_BUDGET.goals.maxOpenCandidates,
    );
  });
});

describe("goals.* handlers", () => {
  it("round-trip through the protocol handlers", async () => {
    const { goals } = setup();
    const h = createGoalHandlers(goals);
    const created = await h["goals.create"]({
      title: "Ship v1",
      category: "career",
      cadence: "0 9 * * 1-5",
      milestones: [{ title: "alpha" }],
    });
    expect(created.goal.status).toBe("active");
    const withMilestone = await h["goals.milestone"]({
      goalId: created.goal.id,
      title: "beta",
      dueAt: null,
    });
    expect(withMilestone.milestones.map((m) => m.title)).toEqual(["alpha", "beta"]);
    const done = await h["goals.milestone"]({
      goalId: created.goal.id,
      milestoneId: withMilestone.milestones[0]?.id,
      done: true,
    });
    expect(done.milestones[0]?.doneAt).not.toBeNull();
    await h["goals.link"]({ goalId: created.goal.id, automationId: "auto_1" });
    const got = await h["goals.get"]({ goalId: created.goal.id });
    expect(got.links).toEqual([
      { goalId: created.goal.id, taskId: null, automationId: "auto_1", watchId: null },
    ]);
    expect((await h["goals.list"]({})).goals.map((g) => g.id)).toEqual([created.goal.id]);
    expect((await h["goals.list"]({ category: "health" })).goals).toEqual([]);
    const updated = await h["goals.update"]({ goalId: created.goal.id, status: "done" });
    expect(updated.goal.status).toBe("done");
    expect((await h["goals.archive"]({ goalId: created.goal.id })).goal.status).toBe("archived");
    await expect(h["goals.get"]({ goalId: "nope" })).rejects.toMatchObject({ code: "not_found" });
  });
});
