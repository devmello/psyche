import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";

let home = "";
let composed: ComposedGateway | null = null;

afterEach(async () => {
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("composition root: proactive surfaces (S15)", () => {
  it("mounts goals, feed and ideas, schedules their system jobs, and an accepted idea is a task card", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-proactive-"));
    composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      timeZone: "UTC",
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    const { proactive, scheduler, tasks } = composed;
    for (const m of [
      "goals.create",
      "goals.decide",
      "feed.list",
      "feed.feedback",
      "ideas.list",
      "ideas.accept",
      "ideas.dismiss",
    ]) {
      expect(Object.keys(proactive.handlers)).toContain(m);
    }
    // The agent's tools are in the loop's registry: reads `none`, changes `write`.
    const se = (name: string) => composed?.loop.registry.get(name)?.spec.sideEffect;
    for (const name of [
      "goals.list",
      "ideas.list",
      "feed.list",
      "feed.explain",
      "feed.mark_read",
    ]) {
      expect(se(name)).toBe("none");
    }
    for (const name of [
      "goals.propose",
      "goals.update_progress",
      "goals.add_checkin",
      "ideas.accept",
      "ideas.dismiss",
      "ideas.snooze",
    ]) {
      expect(se(name)).toBe("write");
    }
    const system = (await scheduler.list()).map((a) => a.title).sort();
    expect(system).toEqual(["Daily brief", "Ideas: delivery window", "Ideas: nightly mining"]);

    // A goal without a check-in → an idea → delivered → accepted: the check-in now exists.
    const { goal } = await proactive.goals.create({
      title: "Sleep 7h",
      category: "health",
      milestones: [{ title: "A week of 7h" }],
    });
    await proactive.ideas.mine();
    await proactive.ideas.deliver();
    const { ideas } = await proactive.ideas.list();
    const plan = ideas.find((i) => i.kind === "task");
    const accepted = await proactive.ideas.accept({ ideaId: plan?.id ?? "" });
    const task = await tasks.get(accepted.taskId ?? "");
    expect(task?.createdFrom).toBe("idea");
    const main = composed.db.sqlite.prepare("SELECT id FROM threads WHERE kind = 'main'").get() as {
      id: string;
    };
    expect(task?.threadId).toBe(main.id);
    expect((await proactive.goals.get(goal.id)).taskIds).toEqual([accepted.taskId]);
    const notifications = await composed.notifier.list();
    expect(notifications.map((n) => n.kind)).toEqual(["proactive"]);
  });
});
