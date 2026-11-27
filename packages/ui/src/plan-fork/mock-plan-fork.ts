import {
  type ApprovalRequest,
  type EventName,
  type EventPayload,
  type ForkReport,
  type MethodName,
  type MethodParams,
  type PlanComparison,
  type PlanFork,
  type PlanForkBranch,
  PsycheError,
  type StagedAction,
} from "@psyche/protocol";
import { fakeSha } from "../fixtures/ids.ts";

/**
 * The `planForks.*` methods of the MockGateway over a `PlanForkWorld`, shaped like the Gateway's
 * (docs/design/fork-a-plan-2026.md §7.2) for stories, tests and the browser preview. The app
 * talks to the real Gateway handlers. `take` issues a real-shaped `staged_apply` approval whose
 * `details.items` lists exactly the items it was given; `tamper` lets a test change that list to
 * prove the client refuses to answer.
 */

export interface PlanForkWorld {
  forks: PlanFork[];
  branches: PlanForkBranch[];
  /** Staged items by branch id. */
  staged: Record<string, StagedAction[]>;
  /** Changes the card's item list before it is issued (tests of the client's hash check). */
  /** The parent chat is still replying: Continue is refused until it ends. */
  chatBusy?: boolean;
  tamper?: (items: Record<string, unknown>[]) => Record<string, unknown>[];
}

export function emptyPlanForks(): PlanForkWorld {
  return { forks: [], branches: [], staged: {} };
}

const NOW = "2026-11-25T09:00:00Z";
const iso = (s: string): string => s;

function cites(call: string, ref: string, source: "memory" | "mail" | "calendar" | "web") {
  return [{ callId: call, ref, source }];
}

export const AUSTIN_REPORT: ForkReport = {
  summary:
    "Moving in June means giving notice by April 1 and paying a lease-break fee. Rent is higher but your sister is ten minutes away.",
  steps: [
    {
      id: "s1",
      text: "Tell the landlord you are leaving",
      who: "psyche",
      stagedId: "stg_austin_mail",
    },
    {
      id: "s2",
      text: "Block June 12 to 15 for the move",
      who: "psyche",
      stagedId: "stg_austin_cal",
    },
    { id: "s3", text: "Book a moving truck", who: "you", when: "2027-05-20" },
    { id: "s4", text: "Remind me to forward my mail", who: "psyche", stagedId: "stg_austin_rem" },
  ],
  costs: [
    {
      id: "c1",
      label: "Breaking the lease",
      amount: 1850,
      currency: "USD",
      period: "once",
      estimate: false,
      cites: cites("call_1", "msg_lease", "mail"),
    },
    {
      id: "c2",
      label: "Movers",
      amount: 2400,
      currency: "USD",
      period: "once",
      estimate: true,
      basis: "Psyche's estimate from two quotes in your mail",
      cites: [],
    },
    {
      id: "c3",
      label: "Rent in Austin",
      amount: 2150,
      currency: "USD",
      period: "month",
      estimate: true,
      basis: "Median for a one-bedroom near the address you searched",
      cites: cites("call_4", "https://example.com/rent-austin", "web"),
    },
  ],
  dates: [
    {
      id: "d1",
      label: "Give notice",
      date: "2027-04-01",
      kind: "deadline",
      estimate: false,
      cites: cites("call_1", "msg_lease", "mail"),
    },
    {
      id: "d2",
      label: "Move in",
      date: "2027-06-15",
      kind: "milestone",
      estimate: true,
      cites: [],
    },
  ],
  people: [
    {
      id: "p1",
      personId: "per_maya",
      name: "Maya",
      effect: "Ten minutes away instead of two hours.",
      cites: cites("call_2", "per_maya", "memory"),
    },
    {
      id: "p2",
      name: "Your landlord",
      effect: "Needs 60 days written notice.",
      cites: cites("call_1", "msg_lease", "mail"),
    },
  ],
  tradeoffs: [
    {
      id: "t1",
      gain: "A bigger kitchen",
      giveUp: "Your Thursday climbing group",
      cites: [],
      unsourced: true,
    },
  ],
  risks: [
    {
      id: "r1",
      text: "The June move overlaps your sister's exam week.",
      likelihood: "medium",
      cites: [],
    },
  ],
  openQuestions: [{ id: "q1", text: "Does the job offer cover moving costs?" }],
};

export const STAY_REPORT: ForkReport = {
  summary: "Staying keeps your lease and routine. The lease renews in August at a higher rent.",
  steps: [
    { id: "s1", text: "Reply to the landlord about renewing", who: "psyche" },
    { id: "s2", text: "Ask for a two-year term", who: "you", when: "2027-06-01" },
  ],
  costs: [
    {
      id: "c1",
      label: "Rent after renewal",
      amount: 1980,
      currency: "USD",
      period: "month",
      estimate: false,
      cites: cites("call_1", "msg_renewal", "mail"),
    },
  ],
  dates: [
    {
      id: "d1",
      label: "Renewal answer",
      date: "2027-06-30",
      kind: "deadline",
      estimate: false,
      cites: cites("call_1", "msg_renewal", "mail"),
    },
  ],
  people: [
    {
      id: "p1",
      personId: "per_maya",
      name: "Maya",
      effect: "Still a two-hour drive.",
      cites: cites("call_2", "per_maya", "memory"),
    },
  ],
  tradeoffs: [
    {
      id: "t1",
      gain: "Your Thursday climbing group",
      giveUp: "A bigger kitchen",
      cites: cites("call_3", "evt_climb", "calendar"),
    },
  ],
  risks: [],
  openQuestions: [],
};

export const MOCK_COMPARISON: PlanComparison = {
  headline: "Austin costs more up front and monthly. Staying keeps your people and routine.",
  rows: [
    {
      dimension: "cost",
      label: "One-time costs",
      cells: [
        { branchId: "fbr_austin", itemIds: ["c1", "c2"] },
        { branchId: "fbr_stay", itemIds: [], note: "None found" },
      ],
      differs: true,
    },
    {
      dimension: "cost",
      label: "Monthly rent",
      cells: [
        { branchId: "fbr_austin", itemIds: ["c3"] },
        { branchId: "fbr_stay", itemIds: ["c1"] },
      ],
      differs: true,
    },
    {
      dimension: "dates",
      label: "Deadlines",
      cells: [
        { branchId: "fbr_austin", itemIds: ["d1", "d2"] },
        { branchId: "fbr_stay", itemIds: ["d1"] },
      ],
      differs: true,
    },
    {
      dimension: "people",
      label: "People affected",
      cells: [
        { branchId: "fbr_austin", itemIds: ["p1", "p2"] },
        { branchId: "fbr_stay", itemIds: ["p1"] },
      ],
      differs: true,
    },
    {
      dimension: "tradeoffs",
      label: "What you give up",
      cells: [
        { branchId: "fbr_austin", itemIds: ["t1"] },
        { branchId: "fbr_stay", itemIds: ["t1"] },
      ],
      differs: false,
    },
    {
      dimension: "open",
      label: "Open questions",
      cells: [
        { branchId: "fbr_austin", itemIds: ["q1"] },
        { branchId: "fbr_stay", itemIds: [] },
      ],
      differs: true,
    },
  ],
  betterIf: [
    { branchId: "fbr_austin", text: "Better if being near Maya matters most this year." },
    {
      branchId: "fbr_stay",
      text: "Better if you want to keep your climbing group and a lower rent.",
    },
  ],
};

function staged(
  id: string,
  branchId: string,
  seq: number,
  kind: "mail" | "calendar" | "reminder",
  summary: string,
  rows: { label: string; value: string; badge?: "new_recipient" | "reply_all" }[],
  send?: { recipients: string[] },
): StagedAction {
  return {
    id,
    nightId: null,
    forkBranchId: branchId,
    seq,
    domain: kind === "reminder" ? "reminders" : kind,
    targetKey: id,
    tool:
      kind === "mail"
        ? "mail_draft_reply"
        : kind === "calendar"
          ? "calendar_create_event"
          : "reminders_add",
    kind: "write",
    sideEffect: "write",
    target: null,
    params: null,
    paramsHash: fakeSha(`p:${id}`),
    bindingHash: fakeSha(`b:${id}`),
    summary,
    preview: {
      kind,
      title: summary,
      rows: rows.map((r) => ({ ...r })),
      truncated: false,
    },
    why: null,
    precondition: null,
    inverse: null,
    send:
      send === undefined ? null : { recipients: send.recipients, contentHash: fakeSha(`s:${id}`) },
    taint: false,
    taintSources: [],
    status: "ready",
    result: null,
    approvalId: null,
    taskId: null,
    toolCallId: null,
    appliedAt: null,
    createdAt: iso(NOW),
    updatedAt: iso(NOW),
  };
}

export function austinStaged(): StagedAction[] {
  return [
    staged(
      "stg_austin_mail",
      "fbr_austin",
      0,
      "mail",
      "Reply to your landlord about leaving",
      [
        { label: "To", value: "rentals@parkview.example", badge: "new_recipient" },
        { label: "Subject", value: "Notice for the lease ending in June" },
        { label: "Body", value: "Hello, I am writing to let you know I will not renew the lease." },
      ],
      { recipients: ["rentals@parkview.example"] },
    ),
    staged("stg_austin_cal", "fbr_austin", 1, "calendar", "Block the move days", [
      { label: "When", value: "June 12 to 15" },
      { label: "Title", value: "Move to Austin" },
    ]),
    staged("stg_austin_rem", "fbr_austin", 2, "reminder", "Remind you to forward your mail", [
      { label: "When", value: "June 1" },
      { label: "Text", value: "Forward mail to the new address" },
    ]),
  ];
}

export function forkFixture(
  status: PlanFork["status"] = "ready",
  threadId = "thr_main",
): { fork: PlanFork; branches: PlanForkBranch[]; staged: StagedAction[] } {
  const done = status === "ready" || status === "taken";
  const base = {
    forkId: "fork_1",
    taskId: null,
    error: null,
    readOwnerOnly: false,
    taint: false,
    taintSources: [],
    tokens: 41_000,
    startedAt: iso(NOW),
    createdAt: iso(NOW),
    updatedAt: iso(NOW),
  };
  const branches: PlanForkBranch[] = [
    {
      ...base,
      id: "fbr_austin",
      ord: 0,
      label: "Move to Austin",
      premise: "Assume we move to Austin by June.",
      threadId: "thr_br_austin",
      status: done ? "reported" : "running",
      report: done ? AUSTIN_REPORT : null,
      spentUsd: 0.21,
      finishedAt: done ? iso(NOW) : null,
    },
    {
      ...base,
      id: "fbr_stay",
      ord: 1,
      label: "Stay",
      premise: "Assume we renew the lease and stay.",
      threadId: "thr_br_stay",
      status: done ? "reported" : "queued",
      report: done ? STAY_REPORT : null,
      spentUsd: done ? 0.15 : 0,
      finishedAt: done ? iso(NOW) : null,
    },
  ];
  const fork: PlanFork = {
    id: "fork_1",
    threadId,
    forkMessageId: null,
    status,
    error: null,
    budgetUsd: 1,
    spentUsd: done ? 0.36 : 0.21,
    tokens: 82_000,
    comparison: done ? MOCK_COMPARISON : null,
    takenBranchId: null,
    takeApprovalId: null,
    createdByDeviceId: null,
    expiresAt: iso("2026-12-02T09:00:00Z"),
    createdAt: iso(NOW),
    updatedAt: iso(NOW),
    finishedAt: done ? iso(NOW) : null,
  };
  return { fork, branches, staged: austinStaged() };
}

/** Seeds a world with one fork in the given state. */
export function seedPlanForks(
  status: PlanFork["status"] = "ready",
  threadId = "thr_main",
): PlanForkWorld {
  const f = forkFixture(status, threadId);
  return { forks: [f.fork], branches: f.branches, staged: { fbr_austin: f.staged } };
}

type Handlers = { [M in MethodName]?: (params: MethodParams<M>) => unknown };

export interface PlanForkCtx {
  world: () => PlanForkWorld;
  now: () => string;
  id: (prefix: string) => string;
  emit: <E extends EventName>(event: E, payload: EventPayload<E>) => void;
  /** Issues a pending approval with this surface's answer token. */
  requestApproval: (approval: ApprovalRequest) => ApprovalRequest;
  approvals: () => ApprovalRequest[];
  answerTokens: () => Record<string, string>;
}

const budgetFor = (n: number) => ({
  maxUsd: Math.round(n * 0.2 * 100) / 100,
  maxTokens: n * 150_000,
});

export function planForkHandlers(ctx: PlanForkCtx): Handlers {
  const findFork = (id: string): PlanFork => {
    const f = ctx.world().forks.find((x) => x.id === id);
    if (f === undefined) throw new PsycheError("not_found", "no such fork");
    return f;
  };
  const view = (f: PlanFork): PlanFork => {
    const a = ctx.approvals().find((x) => x.id === f.takeApprovalId);
    return a?.status === "approved" && f.status === "ready" ? { ...f, status: "taken" } : f;
  };
  const branchesOf = (id: string) => ctx.world().branches.filter((b) => b.forkId === id);
  const update = (f: PlanFork) => {
    const w = ctx.world();
    w.forks = w.forks.map((x) => (x.id === f.id ? f : x));
    ctx.emit("planFork.updated", {
      forkId: f.id,
      threadId: f.threadId,
      status: f.status,
      branches: branchesOf(f.id).map((b) => ({ id: b.id, status: b.status })),
      spentUsd: f.spentUsd,
    });
  };
  return {
    "planForks.suggest": () => ({
      options: [
        { label: "Move to Austin", premise: "Assume we move to Austin by June." },
        { label: "Stay", premise: "Assume we renew the lease and stay." },
      ],
    }),
    "planForks.estimate": (p) => ({ ...budgetFor(p.branches.length), budgetUsd: 1 }),
    "planForks.create": (p) => {
      const w = ctx.world();
      if (
        w.forks.some(
          (f) => f.threadId === p.threadId && (f.status === "running" || f.status === "comparing"),
        )
      )
        throw new PsycheError("conflict", "A fork of this chat is already running");
      const id = ctx.id("fork");
      const now = ctx.now();
      const fork: PlanFork = {
        ...forkFixture("running", p.threadId).fork,
        id,
        forkMessageId: p.messageId,
        createdAt: now,
        updatedAt: now,
        spentUsd: 0,
      };
      const branches: PlanForkBranch[] = p.branches.map((o, ord) => ({
        ...(forkFixture().branches[0] as PlanForkBranch),
        id: `${id}_b${ord}`,
        forkId: id,
        ord,
        label: o.label,
        premise: o.premise,
        threadId: `${id}_t${ord}`,
        status: "running",
        report: null,
        spentUsd: 0,
        finishedAt: null,
        createdAt: now,
        updatedAt: now,
      }));
      w.forks = [fork, ...w.forks];
      w.branches = [...w.branches, ...branches];
      update(fork);
      return { fork, branches };
    },
    "planForks.get": (p) => {
      const f = view(findFork(p.forkId));
      return { fork: f, branches: branchesOf(f.id) };
    },
    "planForks.list": (p) => ({
      forks: ctx
        .world()
        .forks.filter((f) => f.threadId === p.threadId)
        .map(view),
    }),
    "planForks.staged": (p) => ({ items: structuredClone(ctx.world().staged[p.branchId] ?? []) }),
    "planForks.cancel": (p) => {
      const f = findFork(p.forkId);
      const w = ctx.world();
      let n = 0;
      w.branches = w.branches.map((b) => {
        if (b.forkId !== f.id || (p.branchId !== undefined && b.id !== p.branchId)) return b;
        if (b.status !== "running" && b.status !== "queued") return b;
        n += 1;
        return { ...b, status: "cancelled" as const };
      });
      update({ ...f, status: p.branchId === undefined ? "cancelled" : f.status });
      return { cancelled: n };
    },
    "planForks.retryBranch": (p) => {
      const b = ctx.world().branches.find((x) => x.id === p.branchId && x.forkId === p.forkId);
      if (b === undefined) throw new PsycheError("not_found", "no such branch");
      const next: PlanForkBranch = { ...b, status: "queued", error: null };
      const w = ctx.world();
      w.branches = w.branches.map((x) => (x.id === b.id ? next : x));
      return { branch: next };
    },
    "planForks.dismiss": (p) => {
      const f = findFork(p.forkId);
      update({ ...f, status: "dismissed" });
      return { dismissed: true };
    },
    "planForks.take": (p) => {
      const f = view(findFork(p.forkId));
      const b = branchesOf(f.id).find((x) => x.id === p.branchId);
      if (
        f.status === "taken" &&
        f.takenBranchId === p.branchId &&
        p.continue &&
        p.items.length === 0 &&
        p.sends.length === 0
      ) {
        if (f.error !== "continue_pending") return { refused: [] };
        if (ctx.world().chatBusy === true)
          throw new PsycheError("conflict", "the chat is busy; continue when the reply ends");
        update({ ...f, error: null });
        return { refused: [] };
      }
      if (f.status !== "ready" || b?.status !== "reported")
        throw new PsycheError("conflict", "This plan can't be taken now");
      if (p.items.length === 0) {
        update({ ...f, status: "taken", takenBranchId: b.id });
        return { refused: [] };
      }
      const items = ctx.world().staged[b.id] ?? [];
      // The real card: one child per ticked item, and a `<itemId>:send` child per ticked send.
      const rows: Record<string, unknown>[] = p.items.flatMap((i) => {
        const it = items.find((x) => x.id === i.itemId);
        const send = p.sends.find((s) => s.itemId === i.itemId);
        return [
          {
            itemId: i.itemId,
            tool: it?.tool ?? "unknown",
            summary: it?.summary ?? "",
            bindingHash: i.bindingHash,
          },
          ...(send === undefined
            ? []
            : [
                {
                  itemId: `${i.itemId}:send`,
                  tool: "send",
                  summary: it?.summary ?? "",
                  bindingHash: send.sendHash,
                },
              ]),
        ];
      });
      const now = ctx.now();
      const approval = ctx.requestApproval({
        id: ctx.id("apr"),
        kind: "staged_apply",
        summary: `Apply ${rows.length} prepared change${rows.length === 1 ? "" : "s"} from "${b.label}"`,
        details: {
          title: b.label,
          count: rows.length,
          items: ctx.world().tamper ? (ctx.world().tamper?.(rows) ?? rows) : rows,
        },
        bindingHash: fakeSha(`take:${b.id}`),
        grantKey: `staged_apply|${b.id}`,
        requestedBy: { runId: null, taskId: null, threadId: f.threadId },
        sideEffect: "write",
        surfaces: ["desktop", "offMac"],
        scopesOffered: ["once"],
        deviceOnly: true,
        requiresAuthentication: false,
        taint: false,
        riskClass: "sensitive",
        status: "pending",
        scopeGranted: null,
        decidedBy: null,
        requestedAt: now,
        expiresAt: new Date(Date.parse(now) + 10 * 60_000).toISOString(),
        decidedAt: null,
        grantId: null,
      });
      update({ ...f, takeApprovalId: approval.id, takenBranchId: b.id });
      return {
        approval,
        answerToken: ctx.answerTokens()[approval.id] ?? `at_${approval.id}`,
        refused: [],
      };
    },
  };
}
