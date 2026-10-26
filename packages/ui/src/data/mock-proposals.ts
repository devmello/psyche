import {
  type ActionProposal,
  type ApprovalRequest,
  type EventName,
  type EventPayload,
  type MethodName,
  type MethodParams,
  PsycheError,
} from "@psyche/protocol";
import { fakeSha } from "../fixtures/ids.ts";

/**
 * The batch proposal methods of the MockGateway (docs/workflows/mail-and-meetings-2026.md §8.1,
 * §7.2), shaped like `packages/proactive/src/proposals/service.ts`: `approve` issues one `batch`
 * approval (once only) with this surface's answer token; answering it runs the calls (or
 * dismisses the proposal on deny); `undo` offers the inverse as a new pending proposal within
 * 30 s. Per-call failures come from the world (`proposalFailures`). Writes emit
 * `proposal.updated` like the Gateway.
 */

export const UNDO_WINDOW_MS = 30_000;

export interface ProposalMockContext {
  proposals: () => ActionProposal[];
  approvals: () => ApprovalRequest[];
  answerTokens: () => Record<string, string>;
  /** Per proposal id, the calls that fail when it runs and their error. */
  failures: () => Record<string, Record<number, string>>;
  now: () => string;
  emit: <E extends EventName>(event: E, payload: EventPayload<E>) => void;
}

type Handlers = { [M in MethodName]?: (params: MethodParams<M>) => unknown };

function conflict(message: string): never {
  throw new PsycheError("conflict", message);
}

function get(ctx: ProposalMockContext, id: string): ActionProposal {
  return (
    ctx.proposals().find((p) => p.id === id) ??
    (() => {
      throw new PsycheError("not_found", `proposal ${id} not found`);
    })()
  );
}

function save(ctx: ProposalMockContext, next: ActionProposal): ActionProposal {
  const list = ctx.proposals();
  const i = list.findIndex((p) => p.id === next.id);
  if (i === -1) list.unshift(next);
  else list[i] = next;
  ctx.emit("proposal.updated", { proposal: next });
  return next;
}

const INVERSE: Record<string, string> = {
  mail_mark_read: "mail_mark_unread",
  mail_mark_unread: "mail_mark_read",
  mail_flag: "mail_unflag",
  mail_move: "mail_move",
  gmail_modify: "gmail_modify",
};

export function proposalHandlers(ctx: ProposalMockContext): Handlers {
  return {
    "proposals.list": (p) => {
      const wanted = p.status ?? ["pending", "awaiting_approval"];
      return {
        proposals: ctx
          .proposals()
          .filter(
            (x) => wanted.includes(x.status) && (p.postId === undefined || x.postId === p.postId),
          ),
      };
    },
    "proposals.get": (p) => ({ proposal: get(ctx, p.proposalId) }),
    "proposals.approve": (p) => {
      const proposal = get(ctx, p.proposalId);
      if (proposal.status !== "pending") conflict(`proposal ${proposal.id} is ${proposal.status}`);
      const now = ctx.now();
      const approval: ApprovalRequest = {
        id: `appr_${proposal.id}`,
        kind: "batch",
        summary: proposal.title,
        details: {
          proposalId: proposal.id,
          job: proposal.createdBy.job,
          title: proposal.title,
          count: proposal.calls.length,
          calls: proposal.calls.map((c) => c.summary),
        },
        bindingHash: fakeSha(`batch:${proposal.id}`),
        grantKey: `batch|${proposal.id}`,
        requestedBy: { runId: `batch_${proposal.id}`, taskId: null, threadId: null },
        requestedAt: now,
        // The card counts down on the real clock, so the mock's ten minutes start there too.
        expiresAt: new Date(Math.max(Date.parse(now), Date.now()) + 10 * 60_000).toISOString(),
        surfaces: ["desktop", "web"],
        scopesOffered: ["once"],
        deviceOnly: false,
        requiresAuthentication: false,
        sideEffect: "write",
        taint: proposal.taint,
        status: "pending",
        scopeGranted: null,
        decidedBy: null,
        decidedAt: null,
        grantId: null,
      } as ApprovalRequest;
      const token = `token_${approval.id}`;
      ctx.approvals().unshift(approval);
      ctx.answerTokens()[approval.id] = token;
      const next = save(ctx, {
        ...proposal,
        status: "awaiting_approval",
        approvalId: approval.id,
        updatedAt: now,
      });
      ctx.emit("approval.created", { approval, answerToken: token });
      return { proposal: next, approval, answerToken: token };
    },
    "proposals.dismiss": (p) => {
      const proposal = get(ctx, p.proposalId);
      if (proposal.status !== "pending" && proposal.status !== "awaiting_approval")
        conflict(`proposal ${proposal.id} is ${proposal.status}`);
      return { proposal: save(ctx, { ...proposal, status: "dismissed", updatedAt: ctx.now() }) };
    },
    "proposals.undo": (p) => {
      const proposal = get(ctx, p.proposalId);
      if (proposal.status !== "done" && proposal.status !== "partial")
        conflict(`proposal ${proposal.id} has not run`);
      if (Date.parse(ctx.now()) - Date.parse(proposal.updatedAt) > UNDO_WINDOW_MS)
        conflict("the undo window has passed");
      const ok = new Set(
        (proposal.results ?? []).filter((r) => r.status === "ok").map((r) => r.index),
      );
      const calls = proposal.calls
        .filter((c, i) => ok.has(i) && INVERSE[c.tool] !== undefined)
        .map((c) => ({ ...c, tool: INVERSE[c.tool] as string, summary: `Undo: ${c.summary}` }))
        .reverse();
      if (calls.length === 0) conflict("nothing to undo");
      const now = ctx.now();
      const undo: ActionProposal = {
        ...proposal,
        id: `${proposal.id}_undo`,
        title: `Undo: ${proposal.title}`,
        calls,
        status: "pending",
        createdBy: { job: "proposal.undo" },
        approvalId: null,
        results: undefined,
        undoOf: proposal.id,
        createdAt: now,
        updatedAt: now,
      };
      delete undo.results;
      return { proposal: save(ctx, undo) };
    },
  };
}

/**
 * After `approvals.answer` on a `batch` approval: approved → the calls run (per-call results from
 * the world's failures); denied → the proposal is dismissed.
 */
export function settleBatch(ctx: ProposalMockContext, approval: ApprovalRequest): void {
  if (approval.kind !== "batch") return;
  const proposal = ctx.proposals().find((p) => p.approvalId === approval.id);
  if (proposal === undefined) return;
  const now = ctx.now();
  if (approval.status !== "approved") {
    save(ctx, { ...proposal, status: "dismissed", updatedAt: now });
    return;
  }
  const failing = ctx.failures()[proposal.id] ?? {};
  const results = proposal.calls.map((_, index) => {
    const error = failing[index];
    return error === undefined
      ? { index, status: "ok" as const, receiptId: `rcpt_${proposal.id}_${index}` }
      : { index, status: "failed" as const, error };
  });
  const ok = results.filter((r) => r.status === "ok").length;
  // The card times Undo on the real clock, so a run finishes "now" on it as well.
  const finished = new Date(Math.max(Date.parse(now), Date.now())).toISOString();
  save(ctx, {
    ...proposal,
    updatedAt: finished,
    status: ok === results.length ? "done" : ok === 0 ? "failed" : "partial",
    results,
  });
}
