import { describe, expect, it } from "vitest";
import {
  AUTOMATION_HINT,
  automationIntentProvider,
  classifyAutomationIntent,
} from "../src/index.ts";
import { blocks, call, harness, recorder, runTurn, say, spec, until } from "./harness.ts";

/** Task → automation: recognise, plan, trial-run through approvals, then one confirm card. */

const CANVAS =
  "create an automation which checks early in the morning (9am) my UCSC Canvas portal for any assignments due, adds them to Reminders due by 10pm, and then at 11:30pm checks again to ensure they are all submitted.";

describe("classifyAutomationIntent", () => {
  it("recognises the Canvas workflow and other repeatable requests", () => {
    const c = classifyAutomationIntent(CANVAS);
    expect(c.kind).toBe("workflow");
    expect(c.signals).toEqual(expect.arrayContaining(["automation", "again", "several_times"]));
    for (const t of [
      "every Friday at 5pm summarise what I shipped",
      "each morning check my inbox and list what needs a reply",
      "daily, pull the weather and tell me if I need a jacket",
    ]) {
      expect(classifyAutomationIntent(t).kind).toBe("workflow");
    }
  });

  it("leaves one-offs and questions about scheduling alone", () => {
    for (const t of [
      "what assignments are due today on Canvas?",
      "remind me at 9am tomorrow to call Sam",
      "add a reminder to submit the lab at 10pm",
      "how do I schedule something every week?",
      "summarise this PDF",
    ]) {
      expect(classifyAutomationIntent(t)).toEqual({ kind: "one_off", signals: [] });
    }
  });
});

describe("the Canvas example, with a mocked model and connectors", () => {
  const proposeInput = {
    title: "Canvas assignments",
    notify: "notification",
    obstacles: [
      "Canvas needs a sign-in; a calendar feed avoids 2FA.",
      "Adding reminders after reading Canvas asks you each run.",
    ],
    offerSkill: true,
    runs: [
      {
        name: "Morning check",
        kind: "cron",
        schedule: "0 9 * * *",
        humanSchedule: "Every day at 9:00 AM",
        prompt: "Read Canvas for assignments due; add each to Reminders due 10pm.",
        steps: ["Read Canvas", "Add reminders due 10pm", "Record them"],
        approvals: ["Add reminders: asks each run"],
      },
      {
        name: "Evening check",
        kind: "cron",
        schedule: "30 23 * * *",
        humanSchedule: "Every day at 11:30 PM",
        prompt: "Check that every reminder from the morning is submitted.",
        steps: ["Read the morning's state", "Check Canvas for submissions"],
        approvals: [],
      },
    ],
  };

  it("plans two schedules, trial-runs through approvals, then shows one confirm card", async () => {
    const canvas = recorder({ output: { assignments: ["Lab 3"] }, provenance: "untrusted" });
    const reminders = recorder({ output: { id: "rem_1" } });
    const h = harness({
      script: [
        call("p1", "update_plan", {
          items: [
            { text: "Morning run: read Canvas, add reminders", status: "in_progress" },
            { text: "Evening run: check submissions", status: "pending" },
          ],
        }),
        call("c1", "canvas.assignments", {}),
        call("r1", "reminders.add", { title: "Lab 3", due: "22:00" }),
        call("s1", "automation_state_set", {
          group: "canvas-trial",
          data: { reminders: [{ id: "rem_1", title: "Lab 3" }] },
        }),
        call("pa1", "propose_automation", proposeInput),
        say("I proposed both runs; confirm the card to schedule them."),
      ],
      loop: { contextProviders: [automationIntentProvider()] },
    });
    h.loop.registry.register({
      spec: spec("canvas.assignments", "read", { provenanceOut: "untrusted" }),
      execute: canvas.execute,
    });
    h.loop.registry.register({ spec: spec("reminders.add", "write"), execute: reminders.execute });

    // The owner approves each ask as it comes up (the reminders write, the run state write).
    let approved = 0;
    const approver = (async () => {
      while (approved < 2) {
        await until(() => h.broker.issued.length > approved, "approval");
        await h.broker.decideLatest("approve", h.clock, h.broker.issued[approved]?.approval.id);
        approved += 1;
      }
    })();
    const events = await runTurn(h, CANVAS);
    await approver;
    expect(h.broker.issued).toHaveLength(2);

    // Recognised: the hint rode on the owner turn.
    expect(h.provider.requests[0]?.system).toContain(AUTOMATION_HINT);
    expect(h.provider.requests[0]?.system).toContain("propose_automation");
    // Planned with update_plan.
    expect(blocks(events).some((b) => b.type === "checklist")).toBe(true);
    // Trial run: the write after the untrusted read went through the broker as tainted.
    expect(reminders.seen).toHaveLength(1);
    const write = h.broker.decisions.find((d) => d.call.tool === "reminders.add");
    expect(write?.ctx.taint).toBe(true);
    // The run state landed in memory.
    const state = await h.memory.readFile("automations/canvas-trial.json");
    expect(JSON.parse(state?.content ?? "{}")).toMatchObject({ tainted: true });
    // One confirm card, two runs, flagged as built after untrusted reads; nothing scheduled yet.
    const card = blocks(events).find((b) => b.type === "automation_workflow");
    expect(card).toBeDefined();
    if (card?.type !== "automation_workflow") throw new Error("no card");
    expect(card.proposal.runs.map((r) => r.humanSchedule)).toEqual([
      "Every day at 9:00 AM",
      "Every day at 11:30 PM",
    ]);
    expect(card.proposal.tainted).toBe(true);
    expect(card.proposal.groupId).toMatch(/^canvas-assignments-/);
    expect(await h.scheduler.list()).toHaveLength(0);
  });

  it("does not add the hint for a one-off, and rejects a bad schedule", async () => {
    const h = harness({
      script: [say("Lab 3 is due tonight.")],
      loop: { contextProviders: [automationIntentProvider()] },
    });
    await runTurn(h, "what assignments are due today?");
    expect(h.provider.requests[0]?.system ?? "").not.toContain(AUTOMATION_HINT);

    const h2 = harness({
      script: [
        call("pa", "propose_automation", {
          ...proposeInput,
          runs: [{ ...proposeInput.runs[0], schedule: "every morning" }],
        }),
        say("ok"),
      ],
    });
    const events = await runTurn(h2, CANVAS);
    expect(blocks(events).some((b) => b.type === "automation_workflow")).toBe(false);
  });

  it("lets the evening run read what the morning run recorded, as untrusted", async () => {
    const h = harness({
      files: {
        "automations/canvas-assignments-ab12cd.json": JSON.stringify({
          data: { reminders: [{ id: "rem_1", title: "Lab 3" }] },
          tainted: true,
        }),
      },
      script: [
        call("g1", "automation_state_get", { group: "canvas-assignments-ab12cd" }),
        say("Lab 3 is the only one to check."),
      ],
    });
    await runTurn(h, "[workflow:canvas-assignments-ab12cd] Run 2 of 2: Evening check.", {
      mode: "unattended",
    });
    const result = JSON.stringify(h.provider.requests.at(-1)?.messages);
    expect(result).toContain("rem_1");
    expect(result).toContain("untrusted");
  });
});
