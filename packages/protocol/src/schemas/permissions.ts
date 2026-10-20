import { type Static, Type } from "@sinclair/typebox";
import {
  GrantScope,
  Id,
  IsoDateTime,
  JsonObject,
  Nullable,
  Sha256,
  SideEffect,
  StringEnum,
  Surface,
  Target,
  TargetKind,
} from "../common.ts";

/** Data model §4. */
export const ApprovalKind = StringEnum(
  [
    "exec",
    "exec_host",
    "send_email",
    "calendar_write",
    "message_send",
    "browser_submit",
    "credential_fill",
    "purchase",
    "file_write",
    "connector_action",
    "computer_action",
    "new_origin",
    "plan_exit",
    "skill_install",
    "mcp_tool",
    "archive_thread",
    "memory_protected_write",
    "pairing",
    "policy_change",
    "task_start",
  ],
  { $id: "ApprovalKind" },
);
export type ApprovalKind = Static<typeof ApprovalKind>;

export const ApprovalStatus = StringEnum(
  ["pending", "approved", "denied", "expired", "invalidated"],
  {
    $id: "ApprovalStatus",
  },
);
export type ApprovalStatus = Static<typeof ApprovalStatus>;

export const DecidedBy = Type.Union(
  [
    Type.Object({ deviceId: Id, surface: Type.Optional(Surface) }),
    Type.Object({ channel: Type.String(), senderId: Type.String() }),
  ],
  { $id: "DecidedBy" },
);
export type DecidedBy = Static<typeof DecidedBy>;

/** Where taint came from (security §3.6): `{sourceKind, origin or sender, toolCallId}`. */
export const TaintSource = Type.Object(
  {
    sourceKind: Type.String({
      description: "Tool name or source kind (web, email, transcript, task, …)",
    }),
    origin: Type.Optional(Type.String()),
    sender: Type.Optional(Type.String()),
    toolCallId: Type.Optional(Type.String()),
  },
  { $id: "TaintSource" },
);
export type TaintSource = Static<typeof TaintSource>;

/** Wire shape (data model §4.1, security §3.7). Answer tokens are never on the wire to clients that did not receive them. */
export const ApprovalRequest = Type.Object(
  {
    id: Id,
    kind: ApprovalKind,
    summary: Type.String(),
    details: JsonObject,
    bindingHash: Sha256,
    grantKey: Type.String(),
    requestedBy: Type.Object({
      runId: Nullable(Id),
      taskId: Nullable(Id),
      threadId: Nullable(Id),
      toolCallId: Type.Optional(Id),
      agent: Type.Optional(Type.String()),
    }),
    sideEffect: Type.Optional(SideEffect),
    targetKind: Type.Optional(TargetKind),
    target: Type.Optional(Target),
    surfaces: Type.Array(Surface),
    scopesOffered: Type.Array(GrantScope, { minItems: 1 }),
    deviceOnly: Type.Boolean(),
    requiresAuthentication: Type.Boolean(),
    taint: Type.Boolean(),
    /** Where the taint came from (security §3.6, §3.11 `taint.sources`); present only when tainted. */
    taintSources: Type.Optional(Type.Array(TaintSource)),
    status: ApprovalStatus,
    scopeGranted: Nullable(GrantScope),
    decidedBy: Nullable(DecidedBy),
    invalidatedReason: Type.Optional(Type.String()),
    requestedAt: IsoDateTime,
    expiresAt: IsoDateTime,
    decidedAt: Nullable(IsoDateTime),
    grantId: Nullable(Id),
  },
  { $id: "ApprovalRequest" },
);
export type ApprovalRequest = Static<typeof ApprovalRequest>;

/**
 * Fresh user presence for approvals that require authentication (security §3.7): a WebAuthn
 * assertion (web passkeys) or the helper's Touch ID signature, over the approval's presence
 * challenge `sha256("psyche.presence.v1|<approvalId>|<bindingHash>|<answerToken>")` (hex; a
 * WebAuthn client passes its 32 raw bytes as the challenge).
 */
export const PresenceAssertionSchema = Type.Object(
  {
    kind: StringEnum(["webauthn", "helper"]),
    deviceId: Id,
    signature: Type.String({ minLength: 1, maxLength: 4096, description: "base64url" }),
    payload: Type.Optional(
      Type.Record(Type.String({ maxLength: 64 }), Type.String({ maxLength: 16_384 }), {
        description:
          "webauthn: credentialId, authenticatorData, clientDataJSON, userHandle? (base64url); helper: keyId",
      }),
    ),
  },
  { $id: "PresenceAssertion" },
);

export const ApprovalAnswer = Type.Object(
  {
    approvalId: Id,
    answerToken: Type.String({ minLength: 1 }),
    decision: StringEnum(["approve", "deny"]),
    scope: Type.Optional(GrantScope),
    presence: Type.Optional(PresenceAssertionSchema),
  },
  { $id: "ApprovalAnswer" },
);
export type ApprovalAnswer = Static<typeof ApprovalAnswer>;

export const Grant = Type.Object(
  {
    id: Id,
    kind: ApprovalKind,
    scope: GrantScope,
    grantKey: Type.String(),
    subject: JsonObject,
    binding: Nullable(JsonObject),
    expiresAt: Nullable(IsoDateTime),
    useCount: Type.Integer({ minimum: 0 }),
    lastUsedAt: Nullable(IsoDateTime),
    createdFromApprovalId: Nullable(Id),
    taskId: Nullable(Id),
    createdAt: IsoDateTime,
    revokedAt: Nullable(IsoDateTime),
  },
  { $id: "Grant" },
);
export type Grant = Static<typeof Grant>;

export const PolicyRule = Type.Object(
  {
    id: Id,
    priority: Type.Integer(),
    match: JsonObject,
    effect: StringEnum(["allow", "ask", "deny"]),
    note: Nullable(Type.String()),
    createdAt: IsoDateTime,
  },
  { $id: "PolicyRule" },
);
export type PolicyRule = Static<typeof PolicyRule>;

/** Data model §5. */
export const ReceiptOutcome = StringEnum(["ok", "failed", "uncertain"], { $id: "ReceiptOutcome" });
export type ReceiptOutcome = Static<typeof ReceiptOutcome>;

export const Receipt = Type.Object(
  {
    id: Id,
    shortId: Type.Optional(
      Type.String({ description: "Client-visible short id for the receipt line" }),
    ),
    kind: Type.String({ description: "ApprovalKind vocabulary plus read kinds" }),
    taskId: Nullable(Id),
    toolCallId: Nullable(Id),
    approvalId: Nullable(Id),
    outcome: ReceiptOutcome,
    summary: Type.String(),
    externalRefs: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()])),
    payload: Nullable(JsonObject),
    createdAt: IsoDateTime,
  },
  { $id: "Receipt" },
);
export type Receipt = Static<typeof Receipt>;

export const AuditActor = Type.Object(
  {
    type: StringEnum(["agent", "device", "channel", "system", "user"]),
    runId: Type.Optional(Id),
    deviceId: Type.Optional(Id),
    surface: Type.Optional(Surface),
    scope: Type.Optional(Type.String()),
  },
  { $id: "AuditActor" },
);

export const AuditEntry = Type.Object(
  {
    seq: Type.Integer({ minimum: 0 }),
    ts: IsoDateTime,
    kind: Type.String({ description: "e.g. approval.decided, tool_call.finished" }),
    actor: AuditActor,
    subject: Type.Optional(JsonObject),
    data: JsonObject,
    prev: Sha256,
    hash: Sha256,
  },
  { $id: "AuditEntry" },
);
export type AuditEntry = Static<typeof AuditEntry>;
