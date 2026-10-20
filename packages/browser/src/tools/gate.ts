import {
  type ApprovalKind,
  type DecisionContext,
  type PermissionBroker,
  PsycheError,
  type SideEffect,
  type Target,
} from "@psyche/protocol";
import { bindingHash, canonicalJson, sha256 } from "./classify.ts";

/**
 * Executor-side approvals for what only the browser learns while running: a redirect or popup
 * to a new origin (`new_origin`, architecture §8) and a vault fill (`credential_fill`, security
 * §4.6). Everything the spec and `describeCall` can say up front is decided by the agent loop
 * in `before_tool_call`; this gate covers the rest, through the same broker.
 */
export interface CallContext extends DecisionContext {
  toolCallId: string;
  /** Approval the agent loop already obtained for this exact call, if any. */
  approvalId?: string;
}

export interface GateRequest {
  tool: string;
  kind: ApprovalKind;
  sideEffect: SideEffect;
  target: Target;
  summary: string;
  details: Record<string, unknown>;
  bindingFields: unknown;
  /** A binding the executor's verifier recomputes in its own way (the vault's fill envelope). */
  bindingHash?: `sha256:${string}`;
  grantKey: string;
}

export type GateOutcome =
  | { ok: true; approvalId?: string }
  | {
      ok: false;
      code: "policy_denied" | "approval_required";
      message: string;
      approvalId?: string;
    };

export class ApprovalGate {
  #broker: PermissionBroker;

  constructor(broker: PermissionBroker) {
    this.#broker = broker;
  }

  /**
   * Decide, and when the broker says `ask`, request an approval and (attended runs) wait for
   * it. Returns the approval id to bind the dispatch to. Unattended runs never block: the
   * request is queued and the call fails with `approval_required`.
   */
  async check(req: GateRequest, ctx: CallContext, signal: AbortSignal): Promise<GateOutcome> {
    const hash = req.bindingHash ?? bindingHash(req.kind, req.bindingFields);
    const intent = {
      tool: req.tool,
      sideEffect: req.sideEffect,
      targetKind: req.target.kind,
      target: req.target,
      params: req.details,
      paramsHash: sha256(canonicalJson(req.details)),
      kind: req.kind,
      bindingHash: hash,
      grantKey: req.grantKey,
    };
    const decision = await this.#broker.decide(intent, ctx);
    if (decision.decision === "deny") {
      return {
        ok: false,
        code: "policy_denied",
        message: decision.reason ?? `denied by ${decision.rule}`,
      };
    }
    if (decision.decision === "allow") {
      return { ok: true };
    }
    const requestedBy: {
      runId: string | null;
      taskId: string | null;
      threadId: string | null;
      toolCallId?: string;
    } = {
      runId: ctx.runId,
      taskId: ctx.taskId ?? null,
      threadId: ctx.threadId,
      toolCallId: ctx.toolCallId,
    };
    const input: Parameters<PermissionBroker["requestApproval"]>[0] = {
      kind: decision.approvalKind ?? req.kind,
      summary: req.summary,
      details: req.details,
      bindingHash: decision.bindingHash ?? hash,
      grantKey: decision.grantKey ?? req.grantKey,
      requestedBy,
      sideEffect: req.sideEffect,
      targetKind: req.target.kind,
      target: req.target,
      surfaces: ["desktop", "notification"],
      taint: ctx.taint,
    };
    if (decision.scopesOffered !== undefined) input.scopesOffered = decision.scopesOffered;
    const issued = await this.#broker.requestApproval(input);
    const approvalId = issued.approval.id;
    if (ctx.unattended === true) {
      return { ok: false, code: "approval_required", message: "approval queued", approvalId };
    }
    const done = await this.#broker.awaitDecision(approvalId, signal);
    if (done.status !== "approved") {
      return { ok: false, code: "policy_denied", message: `approval ${done.status}`, approvalId };
    }
    const verified = await this.#broker.verifyBinding(approvalId, input.bindingHash);
    if (!verified.ok) {
      return {
        ok: false,
        code: "policy_denied",
        message: `approval ${verified.reason}`,
        approvalId,
      };
    }
    return { ok: true, approvalId };
  }
}

export function gateError(outcome: Exclude<GateOutcome, { ok: true }>): PsycheError {
  return new PsycheError(outcome.code, outcome.message, {
    details: outcome.approvalId === undefined ? {} : { approvalId: outcome.approvalId },
  });
}
