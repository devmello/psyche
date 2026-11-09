import { Type } from "@sinclair/typebox";
import { Id, Nullable } from "../common.ts";
import { ApprovalAnswer, ApprovalRequest, ApprovalStatus, Grant } from "../schemas/permissions.ts";
import { defineMethod, nextCursor, pageParams } from "./define.ts";

/** `approvals.*` (architecture §4.6; data model §4.1; security §3.7). */

/**
 * The single-use answer token for the calling device's surface, when it is one of the request's
 * surfaces and the token is unused (security §3.7). Absent otherwise; never another surface's.
 */
export const SurfaceAnswerToken = Type.String({ minLength: 1, $id: "SurfaceAnswerToken" });

export const ApprovalResult = Type.Object(
  { approval: ApprovalRequest, answerToken: Type.Optional(SurfaceAnswerToken) },
  { $id: "ApprovalResult" },
);

export const ApprovalsMethods = {
  "approvals.list": defineMethod({
    params: Type.Object({ status: Type.Optional(Type.Array(ApprovalStatus)), ...pageParams }),
    result: Type.Object({
      approvals: Type.Array(ApprovalRequest),
      answerTokens: Type.Optional(
        Type.Record(Type.String(), SurfaceAnswerToken, {
          description: "approvalId → this surface's unused answer token",
        }),
      ),
      ...nextCursor,
    }),
    scope: "operator.read",
    description: "Lists approval requests (default: pending), newest first.",
  }),
  "approvals.get": defineMethod({
    params: Type.Object({ approvalId: Id }),
    result: ApprovalResult,
    scope: "operator.read",
    description: "Returns one approval request.",
  }),
  "approvals.answer": defineMethod({
    params: ApprovalAnswer,
    result: Type.Object({ approval: ApprovalRequest, grant: Nullable(Grant) }),
    scope: "operator.approvals",
    description:
      "Approves or denies with the single-use answer token delivered to this surface; deviceOnly and requiresAuthentication kinds are enforced by the Gateway. Not idempotency-keyed: the token is single-use.",
  }),
  "approvals.approveWithTouchId": defineMethod({
    params: Type.Object({
      approvalId: Id,
      /** This window's own answer token for the approval (from `approval.created` or `approvals.get`). */
      answerToken: Type.String({ minLength: 1 }),
      /** Always `once`: the scope is not in the signed challenge, so the window cannot widen it. */
      scope: Type.Optional(Type.Literal("once")),
      /**
       * The helper the desktop launched from its own bundle (`psyche-helper --print-identity`):
       * only that helper is asked to sign. Absent in development builds without a bundled helper.
       */
      helperDeviceId: Type.Optional(Id),
    }),
    result: Type.Object({ approval: ApprovalRequest, grant: Nullable(Grant) }),
    scope: "operator.approvals",
    description:
      "Approves a requiresAuthentication card from the Psyche desktop window with Touch ID on this Mac (security §3.7), once: the Gateway checks the window's answer token, asks the paired helper (helperDeviceId when given) to run Touch ID with a sheet naming the approval and its code, and to sign the presence challenge for that token with its registered key, then answers through the same broker check. One sheet at a time; a failed or invalid confirmation counts against the rejected-answer cap of a remote device (a cancelled sheet or a missing key does not, and the owner's own desktop window is never locked out). UNSANDBOXED is not available on this path. Desktop shell only. Fails unavailable with details.reason helper_offline, helper_outdated, no_presence_key, presence_key_unavailable or presence_key_invalidated; cancelled when the owner cancels Touch ID.",
  }),
  "approvals.approveWithPassword": defineMethod({
    params: Type.Object({
      approvalId: Id,
      /** This window's own answer token for the approval (from `approval.created` or `approvals.get`). */
      answerToken: Type.String({ minLength: 1 }),
    }),
    result: Type.Object({ approval: ApprovalRequest, grant: Nullable(Grant) }),
    scope: "operator.approvals",
    description:
      "Approves a requiresAuthentication card from the Psyche desktop window on Linux by typing the owner's password into the system's own polkit dialog (linux design §9), once. The Gateway checks the window's answer token, asks polkit to authorize the approval's action for this session, then answers through the same broker check with a Gateway-created password presence assertion; no password ever reaches Psyche. Same guards as approveWithTouchId: desktop shell only, one dialog at a time, a wrong password counts against the rejected-answer cap of a remote device (a cancelled dialog does not, and the owner's own desktop window is never locked out). Fails unavailable with details.reason presence_unavailable_here, presence_agent_missing, presence_policy_missing or presence_not_enforced (the matching error codes); cancelled when the owner cancels the dialog.",
  }),
} as const;
