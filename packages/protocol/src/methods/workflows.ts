import { Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { ApprovalRequest } from "../schemas/permissions.ts";
import {
  ActionProposal,
  ActionProposalStatus,
  OpenLoop,
  OpenLoopKind,
  OpenLoopStatus,
} from "../schemas/workflows.ts";
import { SurfaceAnswerToken } from "./approvals.ts";
import { defineMethod, nextCursor, pageParams } from "./define.ts";

/**
 * `proposals.*` (batch proposals, docs/workflows/mail-and-meetings-2026.md §8.1) and
 * `followups.*` (the Follow-ups page, §4.2, §7.1).
 */
export const ProposalsMethods = {
  "proposals.list": defineMethod({
    params: Type.Object({
      status: Type.Optional(Type.Array(ActionProposalStatus)),
      postId: Type.Optional(Id),
      ...pageParams,
    }),
    result: Type.Object({ proposals: Type.Array(ActionProposal), ...nextCursor }),
    scope: "operator.read",
    description: "Lists batch proposals (default: pending and awaiting approval), newest first.",
  }),
  "proposals.get": defineMethod({
    params: Type.Object({ proposalId: Id }),
    result: Type.Object({ proposal: ActionProposal }),
    scope: "operator.read",
    description: "Returns one batch proposal with its calls and, once run, per-call results.",
  }),
  "proposals.approve": defineMethod({
    params: Type.Object({ proposalId: Id }),
    result: Type.Object({
      proposal: ActionProposal,
      /** The `batch` approval bound to the ordered calls; answer it with `approvals.answer`. */
      approval: ApprovalRequest,
      /** This device's single-use answer token for the approval (security §3.7). */
      answerToken: Type.Optional(SurfaceAnswerToken),
    }),
    scope: "operator.approvals",
    sideEffecting: true,
    description:
      "Requests the one batch approval for a proposal (kind batch, bound to the ordered list of calls, once only). The calls run after the approval is answered. Side-effecting.",
  }),
  "proposals.dismiss": defineMethod({
    params: Type.Object({ proposalId: Id }),
    result: Type.Object({ proposal: ActionProposal }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Dismisses a pending proposal; its approval, if any, is invalidated. Side-effecting.",
  }),
  "proposals.undo": defineMethod({
    params: Type.Object({ proposalId: Id }),
    result: Type.Object({ proposal: ActionProposal }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Offers the inverse proposal of a finished one (reversible mail actions only, within 30 s); it needs its own approval. Side-effecting.",
  }),
} as const;

export const FollowupsMethods = {
  "followups.list": defineMethod({
    params: Type.Object({
      status: Type.Optional(Type.Array(OpenLoopStatus)),
      kind: Type.Optional(OpenLoopKind),
      ...pageParams,
    }),
    result: Type.Object({ loops: Type.Array(OpenLoop), ...nextCursor }),
    scope: "operator.read",
    description: "Lists follow-ups (default: open), soonest due first.",
  }),
  "followups.update": defineMethod({
    params: Type.Object({
      loopId: Id,
      action: StringEnum(["resolve", "snooze", "stop", "reopen"], { $id: "FollowupAction" }),
      until: Type.Optional(Nullable(IsoDateTime)),
    }),
    result: Type.Object({ loop: OpenLoop }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Resolves, snoozes (until a time), stops tracking or reopens a follow-up. Side-effecting.",
  }),
} as const;
