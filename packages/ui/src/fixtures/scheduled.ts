import type { AuditChange, AutomationRun, ScheduledItem } from "@psyche/protocol";

/** Wednesday 2026-10-28, 08:00 in Los Angeles. */
export const SCHEDULED_NOW = Date.parse("2026-10-28T15:00:00Z");
export const SCHEDULED_ZONE = "America/Los_Angeles";

const base: Pick<
  ScheduledItem,
  | "timezone"
  | "enabled"
  | "state"
  | "nextRunAt"
  | "lastRunAt"
  | "lastStatus"
  | "summary"
  | "approvals"
  | "deletable"
> = {
  timezone: SCHEDULED_ZONE,
  enabled: true,
  state: "active",
  nextRunAt: null,
  lastRunAt: null,
  lastStatus: null,
  summary: "",
  approvals: [],
  deletable: false,
};

/** The Scheduled screen: owner automations (a linked pair, a paused one) and Psyche's routines. */
export function scheduledItems(): ScheduledItem[] {
  const owner: Pick<ScheduledItem, keyof typeof base | "group" | "kind"> = {
    ...base,
    group: "owner",
    kind: "cron",
    approvals: ["queued"],
    deletable: true,
  };
  return [
    {
      ...owner,
      id: "auto_cart_add",
      title: "Daily groceries: Add to cart",
      schedule: "0 9 * * *",
      nextRunAt: "2026-10-28T16:00:00.000Z",
      lastRunAt: "2026-10-27T16:00:03.000Z",
      lastStatus: "done",
      summary: "Add the usual groceries to the cart.",
      prompt: "[workflow:grp_1] Run 1 of 2\n\nAdd the usual groceries to the cart.",
      linked: {
        groupId: "grp_1",
        runs: [
          {
            id: "auto_cart_check",
            title: "Daily groceries: Check the order",
            schedule: "30 23 * * *",
            nextRunAt: "2026-10-29T06:30:00.000Z",
          },
        ],
      },
    },
    {
      ...owner,
      id: "auto_cart_check",
      title: "Daily groceries: Check the order",
      schedule: "30 23 * * *",
      nextRunAt: "2026-10-29T06:30:00.000Z",
      lastRunAt: "2026-10-28T06:30:02.000Z",
      lastStatus: "failed",
      summary: "Check that the order went through.",
      prompt: "[workflow:grp_1] Run 2 of 2\n\nCheck that the order went through.",
      linked: {
        groupId: "grp_1",
        runs: [
          {
            id: "auto_cart_add",
            title: "Daily groceries: Add to cart",
            schedule: "0 9 * * *",
            nextRunAt: "2026-10-28T16:00:00.000Z",
          },
        ],
      },
    },
    {
      ...owner,
      id: "auto_recap",
      title: "Friday recap",
      schedule: "0 17 * * 5",
      state: "paused",
      enabled: false,
      nextRunAt: null,
      lastRunAt: "2026-10-23T00:00:05.000Z",
      lastStatus: "done",
      summary: "Summarise what I shipped this week.",
      prompt: "Summarise what I shipped this week.",
    },
    {
      ...base,
      id: "auto_brief",
      group: "routine",
      routine: "daily-brief",
      kind: "cron",
      title: "Morning brief",
      schedule: "30 7 * * 1-5",
      nextRunAt: "2026-10-29T14:30:00.000Z",
      lastRunAt: "2026-10-28T14:30:04.000Z",
      lastStatus: "done",
      settings: "daily",
    },
    {
      ...base,
      id: "auto_dream",
      group: "routine",
      routine: "memory-dreaming",
      kind: "cron",
      title: "Memory dreaming",
      schedule: "0 3 * * *",
      nextRunAt: "2026-10-29T10:00:00.000Z",
      lastRunAt: "2026-10-28T10:00:09.000Z",
      lastStatus: "no_reply",
      settings: "people",
    },
    {
      ...base,
      id: "auto_digest",
      group: "routine",
      routine: "mail-digest",
      kind: "cron",
      title: "Inbox digest",
      schedule: "0 8 * * 1-5",
      state: "off",
      enabled: false,
      settings: "mail",
    },
    {
      ...base,
      id: "auto_focus",
      group: "routine",
      routine: "mail-focus",
      kind: "cron",
      title: "Offer focus time",
      schedule: "0 9 * * 1",
      nextRunAt: "2026-11-02T17:00:00.000Z",
      approvals: ["calendar_write"],
      settings: "mail",
    },
  ];
}

/** Past runs of the 9:00 add, newest first. */
export function scheduledRuns(): AutomationRun[] {
  const run = (
    n: number,
    startedAt: string,
    endedAt: string | null,
    over: Partial<AutomationRun>,
  ): AutomationRun => ({
    id: `run_${n}`,
    automationId: "auto_cart_add",
    threadId: `thread_${n}`,
    taskId: `task_${n}`,
    trigger: "schedule",
    scheduledFor: startedAt,
    coalesced: 1,
    startedAt,
    endedAt,
    status: "done",
    summary: "Added 6 items to the cart.",
    notificationId: null,
    runId: `agent_run_${n}`,
    ...over,
  });
  return [
    run(3, "2026-10-28T07:30:00.000Z", "2026-10-28T07:30:41.000Z", { trigger: "manual" }),
    run(2, "2026-10-27T16:00:03.000Z", "2026-10-27T16:02:10.000Z", {}),
    run(1, "2026-10-26T16:00:02.000Z", "2026-10-26T16:00:19.000Z", {
      status: "failed",
      summary: "The shop asked me to sign in again.",
      runId: null,
    }),
  ];
}

/** Audit records of one run (#985). */
export function scheduledChanges(): AuditChange[] {
  return [
    {
      seq: 41,
      hash: "a".repeat(64),
      ts: "2026-10-28T07:30:30.000Z",
      actor: { type: "agent" },
      category: "connector",
      tool: "shop_add_to_cart",
      target: { connector: "shop", object: "Oat milk" },
      action: "added",
      outcome: "ok",
      hasDiff: false,
    },
  ] as AuditChange[];
}
