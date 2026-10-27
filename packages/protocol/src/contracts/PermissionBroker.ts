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
  MissingPermission,
  Receipt,
  TaintSource,
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
 *   `financial` is never `allow` without a consumed `once` approval; a standing grant never
 *   covers a call of a more severe side-effect class than the one approved, and a `task`
 *   grant covers only calls of that same (non-null) task;
 * - a tainted turn turns `allow` into `ask` for write+ actions on a new target;
 * - approvals expire (default 30 min), answer tokens are single-use per surface, the first
 *   authorized answer wins, late/replayed answers are rejected, a restart invalidates pending
 *   requests, and `verifyBinding` rejects a changed `bindingHash`.
 */

/** Default approval lifetime (security §3.7, `approvals.ttlMinutes`). */
export const APPROVAL_TTL_MS = 30 * 60 * 1000;
/** Cards arm after this delay; earlier answers are rejected (architecture §4.6). */
export const APPROVAL_ARM_DELAY_MS = 400;

/**
 * Connector action-matrix key (security §3.11 `permissions.connectors`; feature F5), e.g.
 * `{ id: "google", action: "gmail.send" }`: the broker looks up
 * `config.permissions.connectors[id][action]` (`allow | ask | deny`).
 */
export interface ConnectorRule {
  id: string;
  action: string;
}

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
  /** The connector action-matrix key for this call, when the tool belongs to a connector. */
  connectorRule?: ConnectorRule;
  /**
   * Computer-use facts from the executor's description (`ToolCallDescription.meta`): the app's
   * bundle id and the action (`click`, `type`, `open_app`, …) the per-app tier check keys on
   *. Absent means the tier check uses the tool name.
   */
  meta?: ToolCallMeta;
}

/** Per-call facts the broker's per-app tier check needs (see `ToolCallIntent.meta`). */
export interface ToolCallMeta {
  /** Bundle id of the app the action targets; must equal an `app` target when both are set. */
  app?: string;
  /** Computer-use action name, e.g. `click`, `type`, `open_app`, `focus`. */
  action?: string;
  /**
   * MCP tools (`@psyche/mcp-host` `describeMcpCall`): the server, the `tools/list` hash the
   * registration saw, and the server's trust tier (security §11). The broker binds grants to the
   * server and hash (so `revokeMcpGrants` finds them) and asks for write+ tools of `unknown`
   * servers.
   */
  mcpServerId?: string;
  mcpToolsListHash?: string;
  mcpTier?: "bundled" | "verified" | "unknown";
}

/**
 * Who asked for the call (security §9 "Channels and people"; S10 `RouteContext`). Absent means
 * the owner. The broker keeps standing grants per requester and applies the owner's per-person
 * matrix to designated persons; an `allowed` sender gets nothing above `read`.
 */
export interface Requester {
  role: "owner" | "designated" | "allowed";
  /** `identities.id` (`owner` for the owner) when the sender is linked to an identity. */
  identityId?: string;
  display?: string;
  /** Channel type (`telegram`, `imessage`, …) and the sender's id on it. */
  channel?: string;
  senderId?: string;
  chatId?: string;
  /** `identities.links` (`<channel>:<senderId>`): every chat that reaches this person. */
  links?: string[];
  /** Tool allowlist globs of a delegated persona; absent means no extra limit. */
  toolAllow?: string[];
}

export interface DecisionContext {
  threadId: string;
  runId: string;
  taskId?: string;
  permissionMode: PermissionMode;
  /** Untrusted content was read in this turn (security §3.6). */
  taint: boolean;
  /** Every taint source of the turn so far, for cards and the audit log. */
  taintSources?: TaintSource[];
  /** The target is new relative to the owner's request and earlier approvals in the Task. */
  newTarget?: boolean;
  /** Automation / heartbeat run: `ask` is deferred into the approvals queue. */
  unattended?: boolean;
  /** Who asked (security §9); absent means the owner. */
  requester?: Requester;
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
  /** Set on some `deny`s: what the owner could grant on a `request_permission` card. */
  missing?: MissingPermission;
}

/**
 * What `preview` says an intent would get: `decide`'s decision with `device-only` for an ask whose
 * card is device-only (security §3.7; destructive and financial asks are device-only too).
 */
export type PreviewDecision = "allow" | "ask" | "deny" | "device-only";

export interface PreviewResult {
  tool: string;
  decision: PreviewDecision;
  /** The deciding rule, as `decide` reports it (`mode:balanced/read:new_source`, `grant:<id>`, …). */
  rule: string;
  reason?: string;
  /** Set for `ask` and `device-only`: the approval the call would create. */
  approvalKind?: ApprovalKind;
  scopesOffered?: GrantScope[];
}

export interface ApprovalRequestInput {
  kind: ApprovalKind;
  summary: string;
  details: JsonObject;
  bindingHash: string;
  grantKey: string;
  requestedBy: ApprovalRequest["requestedBy"];
  /** Required: scopes offered, `deviceOnly` and surfaces all follow from it. */
  sideEffect: SideEffect;
  targetKind?: TargetKind;
  target?: Target;
  /** Requested surfaces; the broker strips chat surfaces for `deviceOnly` kinds. */
  surfaces: Surface[];
  /** Narrowed by the broker to what the side-effect class allows. */
  scopesOffered?: GrantScope[];
  taint: boolean;
  /** Taint sources for the card (security §3.6); `context.taintSources` is used when absent. */
  taintSources?: TaintSource[];
  ttlMs?: number;
  /**
   * The decision context of the call (requester, taint sources, task): the card names the
   * person it is for and its taint sources, the requester's own chats are never surfaces, and a
   * restart can re-evaluate the same inputs.
   */
  context?: DecisionContext;
  /**
   * The card writes a lesson (teaching loop §3.3): copied to `ApprovalRequest.fromLesson` so the
   * card shows "Because you said: …" with the owner's words.
   */
  fromLesson?: { lessonId: string; feedbackId: string; because: string };
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
  /**
   * Dry-run `decide` for each intent, in order, with the same rules (§4.4 pre-flight, #686).
   * Strictly side-effect free: no grant is used or created, no ApprovalRequest, no receipt, no
   * audit entry, no circuit-breaker or task-state change. Intents in one call see each other's
   * effect on the Task as they would in sequence, but nothing is kept.
   */
  preview(intents: ToolCallIntent[], ctx: DecisionContext): Promise<PreviewResult[]>;
  requestApproval(input: ApprovalRequestInput): Promise<IssuedApproval>;
  /**
   * Record an answer. Rejects (PsycheError) when the request already has an answer
   * (`answer_late`), expired (`approval_expired`) or was invalidated (`approval_invalidated`),
   * the token was already used (`answer_replayed`) or is unknown (`forbidden`), the card is
   * not armed yet (`approval_not_armed`), or the scope is not offered (`invalid_params`).
   */
  answer(input: ApprovalAnswerInput): Promise<ApprovalRequest>;
  /** Resolves when the request leaves `pending` (approved, denied, expired, invalidated). */
  awaitDecision(approvalId: string, signal?: AbortSignal): Promise<ApprovalRequest>;
  /**
   * Re-verify the exact arguments right before dispatch; consumes a `once` approval. Standing
   * approvals verify only while their grant is live (not revoked, not past `expiresAt`).
   */
  verifyBinding(approvalId: string, bindingHash: string): Promise<BindingVerification>;
  get(approvalId: string): Promise<ApprovalRequest | undefined>;
  list(filter?: { status?: ApprovalStatus }): Promise<ApprovalRequest[]>;
  /**
   * Gateway boot: invalidate every pending request (`gateway_restart`) and issue fresh ones, and
   * revoke `session` grants, which end at a restart (security §3.4).
   */
  reissue(): Promise<IssuedApproval[]>;
  recordReceipt(input: ReceiptInput): Promise<Receipt>;
  listReceipts(filter?: { taskId?: string; toolCallId?: string }): Promise<Receipt[]>;
  /** Cancellation: pending approvals of the run are invalidated, its answers rejected. */
  revokeRunAuthority(runId: string): Promise<void>;
  listGrants(filter?: GrantFilter): Promise<Grant[]>;
  revokeGrant(grantId: string): Promise<Grant>;
}
