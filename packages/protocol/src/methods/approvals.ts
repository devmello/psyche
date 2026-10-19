import { Type } from "@sinclair/typebox";
import { Id, Nullable } from "../common.ts";
import { ApprovalAnswer, ApprovalRequest, ApprovalStatus, Grant } from "../schemas/permissions.ts";
import { defineMethod, nextCursor, pageParams } from "./define.ts";

/** `approvals.*` (architecture §4.6; data model §4.1; security §3.7). */

export const ApprovalResult = Type.Object({ approval: ApprovalRequest }, { $id: "ApprovalResult" });

export const ApprovalsMethods = {
  "approvals.list": defineMethod({
    params: Type.Object({ status: Type.Optional(Type.Array(ApprovalStatus)), ...pageParams }),
    result: Type.Object({ approvals: Type.Array(ApprovalRequest), ...nextCursor }),
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
} as const;
