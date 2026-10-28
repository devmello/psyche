import type { Automation, DailyWorkflowProposal } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { confirmWorkflow, workflowMarker } from "../src/index.ts";
import type { SchedulerLike } from "../src/jobs.ts";

/** The confirmed workflow card becomes linked scheduled automations, once. */

function fakeScheduler(failOn?: number): SchedulerLike & { all: Automation[] } {
  const all: Automation[] = [];
  return {
    all,
    list: async () => [...all],
    get: async (id) => all.find((a) => a.id === id),
    create: async (input) => {
      if (failOn !== undefined && all.length + 1 === failOn) throw new Error("scheduler down");
      const a = { id: `auto_${all.length + 1}`, ...input } as unknown as Automation;
      all.push(a);
      return a;
    },
    update: async () => {
      throw new Error("unused");
    },
    remove: async (id) => {
      all.splice(
        all.findIndex((a) => a.id === id),
        1,
      );
    },
  };
}

const proposal: DailyWorkflowProposal = {
  groupId: "canvas-assignments-ab12cd",
  title: "Canvas assignments",
  timezone: "America/Los_Angeles",
  notify: "both",
  obstacles: [],
  runs: [
    {
      name: "Morning check",
      kind: "cron",
      schedule: "0 9 * * *",
      humanSchedule: "Every day at 9:00 AM",
      prompt: "Read Canvas; add reminders due 10pm.",
      steps: ["Read Canvas"],
      approvals: ["Add reminders"],
    },
    {
      name: "Evening check",
      kind: "cron",
      schedule: "30 23 * * *",
      humanSchedule: "Every day at 11:30 PM",
      prompt: "Check the morning's reminders are submitted.",
      steps: ["Read state"],
      approvals: [],
    },
  ],
};

describe("confirmWorkflow", () => {
  it("creates two linked tasks whose prompts share the group state", async () => {
    const s = fakeScheduler();
    const created = await confirmWorkflow(s, proposal);
    expect(created.map((a) => a.schedule)).toEqual(["0 9 * * *", "30 23 * * *"]);
    expect(created.every((a) => a.timezone === "America/Los_Angeles")).toBe(true);
    for (const a of created) {
      expect(a.prompt.startsWith(workflowMarker(proposal.groupId))).toBe(true);
      expect(a.prompt).toContain(`group "${proposal.groupId}": start with automation_state_get`);
      expect(a.prompt).toContain("Morning check (Every day at 9:00 AM)");
      expect(a.prompt).toContain("Evening check (Every day at 11:30 PM)");
      expect(a.prompt).toContain("notify tool and in the Messages channel");
    }
    expect(created[0]?.prompt).toContain("-> Morning check");
    expect(created[1]?.prompt).toContain("-> Evening check");
    expect(created[1]?.prompt).toContain("Check the morning's reminders");
  });

  it("is idempotent, validates before creating, and rolls back a half-made workflow", async () => {
    const s = fakeScheduler();
    await confirmWorkflow(s, proposal);
    await confirmWorkflow(s, proposal);
    expect(s.all).toHaveLength(2);

    const bad = fakeScheduler();
    await expect(
      confirmWorkflow(bad, {
        ...proposal,
        runs: [
          { ...(proposal.runs[0] as DailyWorkflowProposal["runs"][number]), schedule: "nine am" },
        ],
      }),
    ).rejects.toThrow();
    expect(bad.all).toHaveLength(0);

    const flaky = fakeScheduler(2);
    await expect(confirmWorkflow(flaky, proposal)).rejects.toThrow("scheduler down");
    expect(flaky.all).toHaveLength(0);
  });
});
