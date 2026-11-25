import {
  type ApprovalRequest,
  type EventName,
  type EventPayload,
  type MethodName,
  type MethodParams,
  type NightShiftNight,
  type NightShiftSummary,
  PsycheError,
  type StagedAction,
} from "@psyche/protocol";
import { ago, fakeSha, inMinutes } from "../fixtures/ids.ts";

/**
 * The `nightShift.*` methods of the MockGateway, shaped like the Gateway's (docs/design/
 * night-shift-2026.md §6.2) while the real service (W4, W5) does not exist yet. `apply` re-checks
 * every binding hash, refuses items that are not `ready`, and mints one `staged_apply` approval
 * whose `details.items` lists each item (and each send) with its hash, plus this surface's answer
 * token; answering it settles the items. `tamperApprovals` lets a test make that approval wrong.
 */

export const NIGHT_IDS = {
  night: "night_1018",
  items: {
    reply: "ns_reply_dana",
    long: "ns_reply_long",
    plain: "ns_draft_marco",
    stale: "ns_reply_stale",
    event: "ns_event_move",
    file: "ns_file_invoice",
    reminder: "ns_reminder_call",
  },
} as const;

export interface NightShiftWorld {
  enabled: boolean;
  night: NightShiftNight | null;
  items: StagedAction[];
  /** Per item id, the error its apply fails with (fails before any effect: back to `ready`). */
  failures?: Record<string, string>;
  /** Per item id, a mid-flight throw: the result is `uncertain`. */
  uncertain?: string[];
  /** Per item id, why `apply` refuses it. */
  refuse?: Record<string, string>;
}

let tamper: ((approval: ApprovalRequest) => ApprovalRequest) | null = null;

/**
 * Edits every approval `apply` or `undo` mints from now on, so a test can substitute a call or
 * add keys; `null` stops. It lives outside the world, which the mock clones.
 */
export function tamperApprovals(fn: ((approval: ApprovalRequest) => ApprovalRequest) | null): void {
  tamper = fn;
}

export interface NightShiftMockContext {
  world: () => NightShiftWorld;
  approvals: () => ApprovalRequest[];
  answerTokens: () => Record<string, string>;
  now: () => string;
  emit: <E extends EventName>(event: E, payload: EventPayload<E>) => void;
}

type Handlers = { [M in MethodName]?: (params: MethodParams<M>) => unknown };

const fail = (code: ConstructorParameters<typeof PsycheError>[0], message: string): never => {
  throw new PsycheError(code, message);
};

function item(
  id: string,
  over: Partial<StagedAction> & Pick<StagedAction, "domain" | "summary">,
): StagedAction {
  return {
    id,
    nightId: NIGHT_IDS.night,
    forkBranchId: null,
    seq: 0,
    targetKey: `target_${id}`,
    tool: "mail_reply_draft",
    kind: "mail",
    sideEffect: "write",
    target: null,
    params: { redacted: true },
    paramsHash: fakeSha(`params:${id}`),
    bindingHash: fakeSha(`binding:${id}`),
    preview: null,
    why: null,
    precondition: null,
    inverse: null,
    send: null,
    taint: false,
    taintSources: [],
    status: "ready",
    result: null,
    approvalId: null,
    taskId: null,
    toolCallId: null,
    appliedAt: null,
    createdAt: ago(300),
    updatedAt: ago(300),
    ...over,
  };
}

const LONG_BODY = `${"Thanks for the numbers. I read through the revised plan and have a few notes. ".repeat(6)}`;

/** One night's review: reply drafts (one with a long body and a new recipient), a stale one, a calendar fix, a filed document and a reminder. */
export function nightShiftFixture(): NightShiftWorld {
  const night: NightShiftNight = {
    id: NIGHT_IDS.night,
    night: "2026-10-18",
    status: "done",
    stopReason: null,
    candidates: null,
    spentUsd: 0.31,
    tokens: 42_000,
    reviewStatus: "ready",
    expiresAt: inMinutes(60 * 24 * 2),
    startedAt: ago(540),
    finishedAt: ago(500),
    createdAt: ago(560),
    updatedAt: ago(500),
  };
  const items: StagedAction[] = [
    item(NIGHT_IDS.items.reply, {
      seq: 1,
      domain: "mail",
      summary: "Reply to Dana about the Thursday review",
      why: "Dana asked on Monday whether Thursday still works.",
      preview: {
        rows: [
          { label: "To", value: "dana@example.com" },
          { label: "Subject", value: "Re: Thursday review" },
          { label: "Body", value: "Thursday at 10 works for me. I'll bring the numbers." },
        ],
      },
      send: { recipients: ["dana@example.com"], contentHash: fakeSha("send:dana") },
    }),
    item(NIGHT_IDS.items.long, {
      seq: 2,
      domain: "mail",
      summary: "Reply all to the vendor thread about the revised plan",
      why: "The vendor sent a revised plan on Tuesday.",
      taint: true,
      taintSources: [{ sourceKind: "email", sender: "sam@vendor.example" }],
      preview: {
        kind: "mail",
        title: "Draft a reply to all",
        truncated: true,
        rows: [
          { label: "Reply all", value: "yes", badge: "reply_all" },
          { label: "To", value: "sam@vendor.example", badge: "new_recipient" },
          { label: "Cc", value: "dana@example.com" },
          { label: "Subject", value: "Re: Revised plan" },
          { label: "Body", value: LONG_BODY, truncated: true },
        ],
      },
      send: {
        recipients: ["sam@vendor.example", "dana@example.com"],
        contentHash: fakeSha("send:long"),
      },
    }),
    item(NIGHT_IDS.items.plain, {
      seq: 3,
      domain: "mail",
      summary: "Follow up with Marco about the quote",
      preview: {
        rows: [
          { label: "To", value: "marco@example.com" },
          { label: "Subject", value: "Re: Quote" },
          { label: "Body", value: "Any news on the quote? No rush." },
        ],
      },
    }),
    item(NIGHT_IDS.items.stale, {
      seq: 4,
      domain: "mail",
      status: "stale",
      summary: "Reply to Priya about the invoice",
      result: { error: "A new message arrived in the thread." },
      preview: { rows: [{ label: "To", value: "priya@example.com" }] },
      send: { recipients: ["priya@example.com"], contentHash: fakeSha("send:priya") },
    }),
    item(NIGHT_IDS.items.event, {
      seq: 5,
      domain: "calendar",
      tool: "calendar_update_event",
      kind: "calendar",
      summary: "Move Focus time to 14:00",
      inverse: { restore: true },
      preview: {
        rows: [
          { label: "Starts", value: "Thu 13:00 -> Thu 14:00" },
          { label: "Ends", value: "Thu 15:00 -> Thu 16:00" },
        ],
      },
    }),
    item(NIGHT_IDS.items.file, {
      seq: 6,
      domain: "files",
      tool: "files_move",
      kind: "file",
      summary: "File invoice-0412.pdf under Taxes/2026",
      inverse: { moveBack: true },
      preview: {
        rows: [
          { label: "From", value: "~/Downloads/invoice-0412.pdf" },
          { label: "To", value: "~/Documents/Taxes/2026/invoice-0412.pdf" },
        ],
      },
    }),
    item(NIGHT_IDS.items.reminder, {
      seq: 7,
      domain: "reminders",
      tool: "reminders_create",
      kind: "reminder",
      summary: "Remind you to call the dentist on Friday",
      inverse: { delete: true },
      preview: {
        rows: [
          { label: "Title", value: "Call the dentist" },
          { label: "Due", value: "Fri 09:00" },
        ],
      },
    }),
  ];
  return { enabled: true, night, items };
}

function summary(w: NightShiftWorld): NightShiftSummary | null {
  if (w.night === null) return null;
  const counts = { mail: 0, calendar: 0, reminders: 0, files: 0 };
  for (const i of w.items) if (i.status === "ready") counts[i.domain] += 1;
  return {
    id: w.night.id,
    night: w.night.night,
    status: w.night.status,
    reviewStatus: w.night.reviewStatus,
    counts,
    expiresAt: w.night.expiresAt,
  };
}

function save(ctx: NightShiftMockContext, next: StagedAction): void {
  const w = ctx.world();
  const i = w.items.findIndex((x) => x.id === next.id);
  const stored = { ...next, updatedAt: ctx.now() };
  if (i === -1) w.items.push(stored);
  else w.items[i] = stored;
  ctx.emit("nightShift.item.updated", { item: stored });
}

function reviewOf(ctx: NightShiftMockContext, reviewId: string) {
  const w = ctx.world();
  if (w.night === null || w.night.id !== reviewId)
    fail("not_found", `review ${reviewId} not found`);
  return w.night as NightShiftNight;
}

function mint(
  ctx: NightShiftMockContext,
  seed: string,
  summaryText: string,
  items: Record<string, unknown>[],
  destructive: boolean,
): { approval: ApprovalRequest; answerToken: string } {
  const now = ctx.now();
  let approval = {
    id: `appr_${seed}`,
    kind: "staged_apply",
    summary: summaryText,
    details: { items },
    bindingHash: fakeSha(`staged:${seed}`),
    grantKey: `staged_apply|${seed}`,
    requestedBy: { runId: null, taskId: null, threadId: null },
    requestedAt: now,
    expiresAt: new Date(Math.max(Date.parse(now), Date.now()) + 10 * 60_000).toISOString(),
    surfaces: ["desktop", "web"],
    scopesOffered: ["once"],
    deviceOnly: destructive,
    requiresAuthentication: false,
    sideEffect: "write",
    riskClass: "sensitive",
    taint: false,
    status: "pending",
    scopeGranted: null,
    decidedBy: null,
    decidedAt: null,
    grantId: null,
  } as ApprovalRequest;
  if (tamper) approval = tamper(approval);
  const answerToken = `token_${approval.id}`;
  ctx.approvals().unshift(approval);
  ctx.answerTokens()[approval.id] = answerToken;
  return { approval, answerToken };
}

let seq = 0;

export function nightShiftHandlers(ctx: NightShiftMockContext): Handlers {
  return {
    "nightShift.status": () => {
      const w = ctx.world();
      const night = w.night;
      return {
        enabled: w.enabled,
        nextWindowAt: w.enabled ? "2026-10-19T01:00:00+02:00" : null,
        latest: summary(w),
        readyReviewId:
          night !== null && (night.reviewStatus === "ready" || night.reviewStatus === "partial")
            ? night.id
            : null,
      };
    },
    "nightShift.review.get": (p) => {
      const night = reviewOf(ctx, p.reviewId);
      return { night, items: ctx.world().items.map((i) => ({ ...i })) };
    },
    "nightShift.apply": (p) => {
      const w = ctx.world();
      reviewOf(ctx, p.reviewId);
      const refused: { itemId: string; reason: string }[] = [];
      const items: Record<string, unknown>[] = [];
      for (const a of p.items) {
        const found = w.items.find((i) => i.id === a.itemId);
        const why =
          found === undefined
            ? "That item is gone."
            : found.status !== "ready"
              ? "That item is no longer ready."
              : found.bindingHash !== a.bindingHash
                ? "That item changed since you looked."
                : (w.refuse?.[a.itemId] ?? null);
        if (why !== null) refused.push({ itemId: a.itemId, reason: why });
        else
          items.push({
            itemId: a.itemId,
            bindingHash: a.bindingHash,
            summary: found?.summary ?? "",
          });
      }
      for (const s of p.sends) {
        const found = w.items.find((i) => i.id === s.itemId);
        if (found?.send?.contentHash !== s.sendHash || found.status !== "ready")
          refused.push({ itemId: s.itemId, reason: "That draft changed since you looked." });
        else
          items.push({
            itemId: s.itemId,
            sendHash: s.sendHash,
            recipients: found.send.recipients,
            summary: `Send to ${found.send.recipients.join(", ")}`,
          });
      }
      if (items.length === 0) return { refused };
      seq += 1;
      return {
        ...mint(ctx, `apply_${seq}`, `Apply ${items.length} prepared changes`, items, false),
        refused,
      };
    },
    "nightShift.undo": (p) => {
      const w = ctx.world();
      const refused: { itemId: string; reason: string }[] = [];
      const items: Record<string, unknown>[] = [];
      for (const id of p.itemIds) {
        const found = w.items.find((i) => i.id === id);
        if (found?.status !== "applied" || found.inverse === null)
          refused.push({ itemId: id, reason: "That can't be undone." });
        else items.push({ itemId: id, summary: `Undo: ${found.summary}` });
      }
      if (items.length === 0) return { refused };
      seq += 1;
      return { ...mint(ctx, `undo_${seq}`, "Undo prepared changes", items, true), refused };
    },
    "nightShift.dismiss": (p) => {
      const w = ctx.world();
      reviewOf(ctx, p.reviewId);
      let n = 0;
      for (const i of [...w.items]) {
        if (i.status !== "ready") continue;
        if (p.itemIds !== undefined && !p.itemIds.includes(i.id)) continue;
        save(ctx, { ...i, status: "dismissed" });
        n += 1;
      }
      settleReview(ctx);
      return { dismissed: n };
    },
    "nightShift.runNow": () => ({
      started: false,
      reason: "Night shift is not running in this preview.",
    }),
  };
}

function settleReview(ctx: NightShiftMockContext): void {
  const w = ctx.world();
  if (w.night === null) return;
  const live = w.items.some((i) => i.status === "ready");
  const applied = w.items.some((i) => i.status === "applied" || i.status === "failed");
  const reviewStatus = live ? (applied ? "partial" : "ready") : applied ? "applied" : "dismissed";
  w.night = { ...w.night, reviewStatus, updatedAt: ctx.now() };
  ctx.emit("nightShift.updated", { night: w.night });
}

/** `approvals.answer` on a `staged_apply` card: run (or drop) what its `details.items` lists. */
export function settleNightShift(ctx: NightShiftMockContext, approval: ApprovalRequest): void {
  if (approval.kind !== "staged_apply") return;
  const w = ctx.world();
  const rows = (approval.details as { items?: Record<string, unknown>[] }).items ?? [];
  if (approval.status !== "approved") return;
  const now = ctx.now();
  for (const row of rows) {
    const id = String(row.itemId);
    const found = w.items.find((i) => i.id === id);
    if (found === undefined) continue;
    if (typeof row.sendHash === "string") {
      save(ctx, { ...found, result: { ...found.result, refs: ["sent"] } });
      continue;
    }
    if (found.status === "applied") {
      // An undo.
      save(ctx, { ...found, status: "undone" });
      continue;
    }
    const error = w.failures?.[id];
    if (error !== undefined) save(ctx, { ...found, status: "failed", result: { error } });
    else if (w.uncertain?.includes(id))
      save(ctx, { ...found, status: "uncertain", result: { error: "Check in the app." } });
    else save(ctx, { ...found, status: "applied", appliedAt: now, approvalId: approval.id });
  }
  settleReview(ctx);
}
