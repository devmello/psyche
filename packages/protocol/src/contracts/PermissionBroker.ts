import type {
  Decision,
  GrantScope,
  JsonObject,
  PermissionMode,
  SideEffect,
  Surface,
  Target,
  TargetKind,
} from "../common.ts";
import type {
  ApprovalAnswer,
  ApprovalKind,
  ApprovalRequest,
  ApprovalStatus,
  DecidedBy,
  Grant,
  Receipt,
} from "../schemas/permissions.ts";

/**
 * Permission Broker contract (architecture §4.6; security §3; owner S05). The only component
 * that can authorize a side effect. Evaluation order (security §3.3): hard prohibitions → user
 * deny rules → hooks → taint escalation → standing grants → mode default → classifier.
 *
 * Invariants every implementation keeps (checked by `describePermissionBrokerConformance`):
 * - a deny rule beats any allow, including standing grants;
 * - `plan` mode denies every tool whose `sideEffect` is not `none`;
 * - `destructive` is offered/granted only `once | task`, `financial` only `once`, and
 *   `financial` is never `allow` without a consumed `once` approval;
 * - a tainted turn turns `allow` into `ask` for write+ actions on a new target;
 * - approvals expire (default 30 min), answer tokens are single-use per surface, the first
 *   authorized answer wins, late/replayed answers are rejected, a restart invalidates pending
 *   requests, and `verifyBinding` rejects a changed `bindingHash`.
 */

/** Default approval lifetime (security §3.7, `approvals.ttlMinutes`). */
export const APPROVAL_TTL_MS = 30 * 60 * 1000;
/** Cards arm after this delay; earlier answers are rejected (architecture §4.6). */
export const APPROVAL_ARM_DELAY_MS = 400;

/** The tool call (or `node.invoke`) being decided. */
export interface ToolCallIntent {
  tool: string;
  sideEffect: SideEffect;
  targetKind?: TargetKind;
  target?: Target;
  /** Params with `{{cred:…}}` placeholders kept; never secrets. */
  params: unknown;
  paramsHash: string;
  /** Approval kind this call maps to; the broker infers one when absent. */
  kind?: ApprovalKind;
  /** Precomputed by the caller; the broker computes its own when absent. */
  bindingHash?: string;
  grantKey?: string;
}

export interface DecisionContext {
  threadId: string;
  runId: string;
  taskId?: string;
  permissionMode: PermissionMode;
  /** Untrusted content was read in this turn (security §3.6). */
  taint: boolean;
  /** The target is new relative to the owner's request and earlier approvals in the Task. */
  newTarget?: boolean;
  /** Automation / heartbeat run: `ask` is deferred into the approvals queue. */
  unattended?: boolean;
}

export interface DecisionResult {
  decision: Decision;
  /** Deciding rule for the audit log, e.g. `mode:balanced/write`, `grant:<id>`, `taint:new_target`. */
  rule: string;
  reason?: string;
  /** Set when `decision` is `ask`: what to put in the ApprovalRequest. */
  approvalKind?: ApprovalKind;
  scopesOffered?: GrantScope[];
  bindingHash?: string;
  grantKey?: string;
  grantId?: string;
}

export interface ApprovalRequestInput {
  kind: ApprovalKind;
  summary: string;
  details: JsonObject;
  bindingHash: string;
  grantKey: string;
  requestedBy: ApprovalRequest["requestedBy"];
  sideEffect?: SideEffect;
  targetKind?: TargetKind;
  target?: Target;
  /** Requested surfaces; the broker strips chat surfaces for `deviceOnly` kinds. */
  surfaces: Surface[];
  /** Narrowed by the broker to what the side-effect class allows. */
  scopesOffered?: GrantScope[];
  taint: boolean;
  ttlMs?: number;
}

/** A created request plus one single-use answer token per delivered surface. Tokens are returned only here. */
export interface IssuedApproval {
  approval: ApprovalRequest;
  answerTokens: Record<Surface, string>;
}

export interface ApprovalAnswerInput extends ApprovalAnswer {
  decidedBy: DecidedBy;
}

export type BindingVerification =
  | { ok: true; approval: ApprovalRequest }
  | {
      ok: false;
      reason:
        | "binding_mismatch"
        | "not_approved"
        | "consumed"
        | "expired"
        | "not_found"
        | "revoked";
    };

export interface ReceiptInput {
  kind: string;
  outcome: Receipt["outcome"];
  summary: string;
  taskId?: string | null;
  toolCallId?: string | null;
  approvalId?: string | null;
  externalRefs?: Record<string, string | number>;
  payload?: JsonObject | null;
  shortId?: string;
}

export interface GrantFilter {
  kind?: ApprovalKind;
  includeRevoked?: boolean;
}

export interface PermissionBroker {
  decide(call: ToolCallIntent, ctx: DecisionContext): Promise<DecisionResult>;
  requestApproval(input: ApprovalRequestInput): Promise<IssuedApproval>;
  /**
   * Record an answer. Rejects (PsycheError) when the request is not pending (`conflict`,
   * `approval_expired`, `approval_invalidated`), the token is unknown or used (`forbidden`),
   * the card is not armed yet (`forbidden`), or the scope is not offered (`invalid_params`).
   */
  answer(input: ApprovalAnswerInput): Promise<ApprovalRequest>;
  /** Resolves when the request leaves `pending` (approved, denied, expired, invalidated). */
  awaitDecision(approvalId: string, signal?: AbortSignal): Promise<ApprovalRequest>;
  /** Re-verify the exact arguments right before dispatch; consumes a `once` approval. */
  verifyBinding(approvalId: string, bindingHash: string): Promise<BindingVerification>;
  get(approvalId: string): Promise<ApprovalRequest | undefined>;
  list(filter?: { status?: ApprovalStatus }): Promise<ApprovalRequest[]>;
  /** Gateway boot: invalidate every pending request (`gateway_restart`) and issue fresh ones. */
  reissue(): Promise<IssuedApproval[]>;
  recordReceipt(input: ReceiptInput): Promise<Receipt>;
  listReceipts(filter?: { taskId?: string; toolCallId?: string }): Promise<Receipt[]>;
  /** Cancellation: pending approvals of the run are invalidated, its answers rejected. */
  revokeRunAuthority(runId: string): Promise<void>;
  listGrants(filter?: GrantFilter): Promise<Grant[]>;
  revokeGrant(grantId: string): Promise<Grant>;
}
