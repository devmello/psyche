import type {
  ApprovalHint,
  Notification,
  RunBudget,
  SpecialistJob,
  SpecialistResult,
  SpecialistRole,
  Task,
} from "@psyche/protocol";
import { ago, IDS } from "./ids.ts";

/**
 * Background specialists (docs/agent/specialists-2026.md §5.2, §6): the six bundled roles with
 * the owner's settings, and one job per card state for the Inbox, the Feed and the parent thread.
 */

export const SPECIALIST_IDS = {
  tasks: {
    done: "task_spec_apartments",
    partial: "task_spec_headphones",
    failed: "task_spec_flaky_test",
    cancelled: "task_spec_downloads",
    needsYou: "task_spec_toast",
    working: "task_spec_week_plan",
    queued: "task_spec_gift_ideas",
  },
  threads: {
    done: "th_spec_apartments",
    partial: "th_spec_headphones",
    failed: "th_spec_flaky_test",
    cancelled: "th_spec_downloads",
    needsYou: "th_spec_toast",
    working: "th_spec_week_plan",
    queued: "th_spec_gift_ideas",
  },
  runs: {
    done: "run_spec_apartments",
    partial: "run_spec_headphones",
    failed: "run_spec_flaky_test",
    cancelled: "run_spec_downloads",
    needsYou: "run_spec_toast",
    working: "run_spec_week_plan",
  },
  /** The chat that started them; stories that show the spawn lines move them onto a thread. */
  parent: { threadId: "th_spec_parent", runId: "run_spec_parent" },
  notifications: {
    done: IDS.notifications.specialistResult,
    partial: "ntf_spec_headphones",
    failed: "ntf_spec_flaky_test",
    cancelled: "ntf_spec_downloads",
  },
} as const;

const S = SPECIALIST_IDS;

type Budget = { tokens: number; costUsd: number; minutes: number };

function role(
  id: string,
  label: string,
  description: string,
  partial: Pick<SpecialistRole, "modelClass" | "result" | "tools" | "approvals"> & {
    budget: Budget;
    caps: Budget;
    planFirst?: boolean;
    enabled?: boolean;
  },
): SpecialistRole {
  return {
    role: id,
    label,
    description,
    skill: `specialist-${id}`,
    source: "bundled",
    enabled: partial.enabled ?? true,
    modelClass: partial.modelClass,
    model: null,
    maxMode: "balanced",
    tools: partial.tools,
    result: partial.result,
    planFirst: partial.planFirst ?? false,
    budget: partial.budget,
    caps: { ...partial.caps, maxHours: 24 },
    approvals: partial.approvals,
  };
}

/** The six bundled roles (§5.2), as `specialists.list` returns them. */
export function specialistRoles(): SpecialistRole[] {
  return [
    role("researcher", "Researcher", "Multi-source research into a cited brief.", {
      modelClass: "primary",
      result: "findings",
      tools: ["search", "fetch", "browser.*", "memory_search", "pdf.*", "artifact.create"],
      approvals: ["new_origin"],
      budget: { tokens: 400_000, costUsd: 2, minutes: 30 },
      caps: { tokens: 2_000_000, costUsd: 10, minutes: 240 },
    }),
    role("shopper", "Shopper", "Finds, compares and holds items. Never buys.", {
      modelClass: "vision",
      result: "items",
      tools: ["search", "fetch", "browser.*", "shop_search", "artifact.create"],
      approvals: ["new_origin", "browser_submit"],
      budget: { tokens: 300_000, costUsd: 2, minutes: 45 },
      caps: { tokens: 1_500_000, costUsd: 10, minutes: 240 },
      planFirst: true,
    }),
    role("coder", "Coder", "A tested change in a granted repo.", {
      modelClass: "harness",
      result: "changes",
      tools: ["code.*", "read_file", "edit_file", "write_file", "exec"],
      approvals: ["file_write", "exec"],
      budget: { tokens: 1_000_000, costUsd: 5, minutes: 60 },
      caps: { tokens: 4_000_000, costUsd: 20, minutes: 480 },
      planFirst: true,
    }),
    role("organizer", "Organizer", "Files, mail, reminders and calendar tidy-ups.", {
      modelClass: "utility",
      result: "changes",
      tools: ["files.*", "email.*", "reminders.*", "calendar.*", "notes.*"],
      approvals: ["file_write", "calendar_write"],
      budget: { tokens: 150_000, costUsd: 0.5, minutes: 20 },
      caps: { tokens: 600_000, costUsd: 2, minutes: 120 },
    }),
    role("writer", "Writer", "A draft from sources, in your voice.", {
      modelClass: "primary",
      result: "draft",
      tools: ["memory_search", "read_file", "fetch", "pdf.*", "artifact.create", "mail_draft"],
      approvals: ["new_origin"],
      budget: { tokens: 200_000, costUsd: 1, minutes: 20 },
      caps: { tokens: 800_000, costUsd: 4, minutes: 120 },
    }),
    role("planner", "Planner", "A plan or schedule. Changes nothing.", {
      modelClass: "primary",
      result: "plan",
      tools: ["calendar_list_events", "reminders_list", "search", "fetch", "artifact.create"],
      approvals: [],
      budget: { tokens: 150_000, costUsd: 1, minutes: 15 },
      caps: { tokens: 600_000, costUsd: 4, minutes: 120 },
      enabled: false,
    }),
  ];
}

function budget(
  limit: Budget,
  used: { tokens: number; costUsd: number | null; minutes: number; steps: number },
): RunBudget {
  return {
    limit: { tokens: limit.tokens, costUsd: limit.costUsd, wallMs: limit.minutes * 60_000 },
    used: {
      steps: used.steps,
      tokens: used.tokens,
      wallMs: used.minutes * 60_000,
      costUsd: used.costUsd,
    },
  };
}

function result(
  partial: Pick<SpecialistResult, "outcome" | "summary"> & Partial<SpecialistResult>,
) {
  return {
    findings: [],
    artifacts: [],
    next: [],
    gaps: [],
    receipts: [],
    tainted: false,
    ...partial,
  } satisfies SpecialistResult;
}

function job(
  partial: Pick<SpecialistJob, "taskId" | "threadId" | "role" | "title" | "status" | "budget"> &
    Partial<SpecialistJob>,
): SpecialistJob {
  return {
    runId: null,
    parentThreadId: "th_spec_parent",
    parentRunId: "run_spec_parent",
    queuePosition: null,
    deadline: null,
    lastStep: null,
    createdAt: ago(40),
    updatedAt: ago(18),
    result: null,
    preflight: PREFLIGHT[partial.role] ?? [],
    ...partial,
  };
}

/** The spawn's pre-flight per role, in the runtime's words (agent-core `preflight`). */
const NEW_SITES: ApprovalHint = { kind: "new_origin", label: "Will ask before opening new sites" };
const PREFLIGHT: Record<string, ApprovalHint[]> = {
  researcher: [{ ...NEW_SITES, estimate: 5 }],
  shopper: [
    NEW_SITES,
    { kind: "browser_submit", label: "Will ask before submitting forms" },
    { kind: "plan_exit", label: "Will show you a plan to approve first" },
  ],
  coder: [
    { kind: "file_write", label: "Will ask before changing files" },
    { kind: "exec", label: "Will ask before running commands" },
    { kind: "plan_exit", label: "Will show you a plan to approve first" },
  ],
  organizer: [
    { kind: "file_write", label: "Will ask before changing files" },
    { kind: "calendar_write", label: "Will ask before changing your calendar" },
  ],
  writer: [NEW_SITES],
  planner: [],
};

/** The done result: three findings, a brief, two receipts, read from six sites (tainted). */
export const DONE_RESULT: SpecialistResult = result({
  outcome: "done",
  summary:
    "Three flats within a 15-minute walk of the office fit the budget. The Rua da Rosa one is the best value; the other two need a viewing this week.",
  findings: [
    {
      title: "Rua da Rosa 41, 2nd floor · €1,450",
      detail: "12 min walk. Furnished, available Nov 1. The listing went up yesterday.",
      sources: ["https://example-rentals.pt/rosa-41"],
    },
    {
      title: "Travessa do Carmo 8 · €1,520",
      detail: "9 min walk. Unfurnished; the agent replies within a day.",
      sources: ["https://example-rentals.pt/carmo-8"],
    },
    {
      title: "Calçada do Combro 112 · €1,390",
      detail: "15 min walk, steep hill. Viewing slots on Thursday only.",
      sources: ["https://example-homes.pt/combro-112"],
    },
    {
      title: "Rua do Século 20 · €1,600",
      detail: "11 min walk. Over budget by €100 but includes bills.",
    },
  ],
  artifacts: [IDS.artifacts.itinerary],
  next: [
    { label: "Book viewings", message: "Book viewings for the three flats the researcher found." },
    { label: "Email the agents", message: "Draft emails to the agents for the top two flats." },
  ],
  receipts: [IDS.receipts.browserRead, IDS.receipts.emailSent],
  tainted: true,
  evaluator: { verdict: "done", reason: "Every listing has a source and a price." },
});

/** One job per card state (§6.2), all started by one chat (`SPECIALIST_IDS.parent`). */
export function specialistJobs(): SpecialistJob[] {
  const roles = Object.fromEntries(specialistRoles().map((r) => [r.role, r]));
  const limit = (id: string): Budget => {
    const b = roles[id]?.budget;
    return { tokens: b?.tokens ?? 1, costUsd: b?.costUsd ?? 0, minutes: b?.minutes ?? 1 };
  };
  return [
    job({
      taskId: S.tasks.done,
      threadId: S.threads.done,
      runId: S.runs.done,
      role: "researcher",
      title: "Apartments near the office",
      status: "done",
      budget: budget(limit("researcher"), {
        tokens: 182_000,
        costUsd: 0.84,
        minutes: 22,
        steps: 31,
      }),
      lastStep: "Wrote the brief",
      createdAt: ago(42),
      updatedAt: ago(20),
      result: DONE_RESULT,
    }),
    job({
      taskId: S.tasks.partial,
      threadId: S.threads.partial,
      runId: S.runs.partial,
      role: "shopper",
      title: "Noise-cancelling headphones under $300",
      status: "partial",
      budget: {
        ...budget(limit("shopper"), { tokens: 300_000, costUsd: 1.62, minutes: 31, steps: 44 }),
        used: {
          steps: 44,
          tokens: 300_000,
          wallMs: 31 * 60_000,
          costUsd: 1.62,
          retried: { tokens: 21_000, costUsd: 0.12 },
        },
      },
      createdAt: ago(95),
      updatedAt: ago(60),
      result: result({
        outcome: "partial",
        summary: "Two of four stores checked. The Sony pair is $279 at both, in stock.",
        stopReason: "budget:tokens",
        findings: [
          { title: "Sony WH-1000XM5 · $279", detail: "In stock at both stores. Free returns." },
          { title: "Bose QC Ultra · $299", detail: "Back-ordered until Nov 4." },
        ],
        gaps: ["Didn't check Best Buy or Target: the token budget ran out."],
        receipts: [IDS.receipts.browserRead],
        tainted: true,
      }),
    }),
    job({
      taskId: S.tasks.failed,
      threadId: S.threads.failed,
      runId: S.runs.failed,
      role: "coder",
      title: "Fix the flaky sidebar test",
      status: "failed",
      budget: budget(limit("coder"), { tokens: 64_000, costUsd: 0.31, minutes: 6, steps: 9 }),
      createdAt: ago(130),
      updatedAt: ago(124),
      result: result({
        outcome: "failed",
        summary: "The tests wouldn't start: the repo needs its dependencies installed first.",
        stopReason: "error",
        gaps: ["Run pnpm install in ~/Projects/psyche, then retry."],
      }),
    }),
    job({
      taskId: S.tasks.cancelled,
      threadId: S.threads.cancelled,
      runId: S.runs.cancelled,
      role: "organizer",
      title: "Tidy the Downloads folder",
      status: "cancelled",
      budget: budget(limit("organizer"), { tokens: 22_000, costUsd: 0.04, minutes: 3, steps: 7 }),
      createdAt: ago(300),
      updatedAt: ago(296),
      result: result({
        outcome: "cancelled",
        summary: "Moved 14 installers to Archive before you stopped it.",
        stopReason: "owner",
        receipts: [IDS.receipts.calendarWrite],
      }),
    }),
    job({
      taskId: S.tasks.needsYou,
      threadId: S.threads.needsYou,
      runId: S.runs.needsYou,
      role: "writer",
      title: "Toast for Maya's farewell",
      status: "needs_you",
      budget: budget(limit("writer"), { tokens: 41_000, costUsd: 0.22, minutes: 4, steps: 8 }),
      lastStep: "Waiting for your approval",
      createdAt: ago(12),
      updatedAt: ago(2),
    }),
    job({
      taskId: S.tasks.working,
      threadId: S.threads.working,
      runId: S.runs.working,
      role: "researcher",
      title: "Compare the three pension funds",
      status: "working",
      budget: budget(limit("researcher"), {
        tokens: 260_000,
        costUsd: 1.2,
        minutes: 14,
        steps: 22,
      }),
      lastStep: "Reading the fee tables",
      createdAt: ago(15),
      updatedAt: ago(0),
    }),
    job({
      taskId: S.tasks.queued,
      threadId: S.threads.queued,
      role: "shopper",
      title: "Birthday gift ideas for Sam",
      status: "queued",
      queuePosition: 2,
      budget: budget(limit("shopper"), { tokens: 0, costUsd: 0, minutes: 0, steps: 0 }),
      createdAt: ago(1),
      updatedAt: ago(1),
    }),
  ];
}

/** Tasks behind the finished jobs, so Retry (`tasks.retry`) finds them. */
export function specialistTasks(): Task[] {
  return specialistJobs().map((j) => ({
    id: j.taskId,
    threadId: j.threadId,
    title: j.title,
    goal: j.title,
    status:
      j.status === "done"
        ? "done"
        : j.status === "failed" || j.status === "partial"
          ? "failed"
          : j.status === "cancelled"
            ? "cancelled"
            : j.status === "queued"
              ? "queued"
              : "running",
    createdFrom: "subagent",
    plan: null,
    checklist: [],
    currentStepId: null,
    attempt: 1,
    leaseOwner: null,
    leaseUntil: null,
    browserSessionId: null,
    sandboxId: null,
    summary: null,
    outcome: null,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    completedAt: null,
  }));
}

function resultNotification(
  id: string,
  taskId: string,
  title: string,
  body: string,
  createdAt: string,
): Notification {
  return {
    id,
    kind: "specialist_result",
    title,
    body,
    taskId,
    approvalId: null,
    route: "/inbox",
    actions: [{ id: "open", label: "Open" }],
    surfaces: ["desktop", "notification"],
    delivered: { desktop: createdAt },
    readAt: null,
    resolvedAt: null,
    createdAt,
  };
}

/** One `specialist_result` notification per finished job besides the fixture world's own. */
export function specialistNotifications(): Notification[] {
  return [
    resultNotification(
      S.notifications.partial,
      S.tasks.partial,
      "Shopper stopped at its budget on Noise-cancelling headphones under $300",
      "Partial · token budget",
      ago(60),
    ),
    resultNotification(
      S.notifications.failed,
      S.tasks.failed,
      "Coder couldn't finish Fix the flaky sidebar test",
      "Failed",
      ago(124),
    ),
    resultNotification(
      S.notifications.cancelled,
      S.tasks.cancelled,
      "Organizer stopped: Tidy the Downloads folder",
      "Cancelled",
      ago(296),
    ),
  ];
}

/**
 * Adds what the default fixture world leaves out: the jobs' tasks (so Retry finds them), the
 * link from the world's specialist notification to its job, and, with `notifications`, a result
 * notification for each other finished job.
 */
export function withSpecialists<W extends { tasks: Task[]; notifications: Notification[] }>(
  w: W,
  options: { notifications?: boolean } = {},
): W {
  w.tasks = [...w.tasks, ...specialistTasks()];
  // The world's own specialist notification names no task until its task exists.
  w.notifications = w.notifications.map((n) =>
    n.id === S.notifications.done ? { ...n, taskId: S.tasks.done } : n,
  );
  if (options.notifications === true)
    w.notifications = [...w.notifications, ...specialistNotifications()];
  return w;
}
