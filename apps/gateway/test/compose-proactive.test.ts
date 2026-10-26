import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@psyche/agent-core";
import { insertDevice } from "@psyche/db";
import { FakeModelProvider } from "@psyche/testing";
import { Type } from "@sinclair/typebox";
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
      "mail.draft_reply",
      "mail.propose_times",
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
    expect(system).toEqual([
      "Check for new mail",
      "Daily brief",
      "Ideas: delivery window",
      "Ideas: nightly mining",
      "Inbox digest",
      "Learn my writing style",
      "Meeting prep",
      "Memory dreaming",
      "What I learned this week",
    ]);

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

  it("runs an approved batch proposal through the composed broker and registry (W2)", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-proposals-"));
    composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      timeZone: "UTC",
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    const ran: unknown[] = [];
    composed.loop.registry.register(
      defineTool({
        name: "mail_set_flags",
        description: "Mark read",
        input: Type.Object({ ids: Type.Array(Type.String()), read: Type.Boolean() }),
        sideEffect: "write",
        run: async (params, ctx) => {
          ran.push({ params, approvalId: ctx.authority?.approvalId });
          return { output: { ok: true }, provenance: "trusted" };
        },
      }),
    );
    insertDevice(composed.db, {
      id: "dev_mac",
      name: "Mac",
      platform: "macos",
      role: "client",
      publicKey: "AAAA",
      scopes: ["operator.read", "operator.write", "operator.approvals"],
    });
    const proposals = composed.proactive.proposals;
    expect(proposals).toBeDefined();
    expect(Object.keys(composed.proactive.handlers)).toEqual(
      expect.arrayContaining(["proposals.list", "proposals.approve", "proposals.undo"]),
    );
    const p = proposals?.create({
      title: "Mark 2 read",
      calls: [
        { tool: "mail_set_flags", params: { ids: ["a"], read: true }, summary: "Mark read: a" },
        { tool: "mail_set_flags", params: { ids: ["b"], read: true }, summary: "Mark read: b" },
      ],
      createdBy: { job: "mail.digest" },
    });
    const approved = await proposals?.approve(p?.id ?? "");
    await new Promise((r) => setTimeout(r, 450));
    await composed.broker.answer({
      approvalId: approved?.issued.approval.id ?? "",
      answerToken: approved?.issued.answerTokens.desktop ?? "",
      decision: "approve",
      scope: "once",
      decidedBy: { deviceId: "dev_mac", surface: "desktop" },
    });
    await proposals?.idle();
    expect(ran).toHaveLength(2);
    expect(proposals?.get(p?.id ?? "").status).toBe("done");
  });
});
