import { Type } from "@sinclair/typebox";
import { Id, Nullable } from "../common.ts";
import {
  NightShiftApplyItem,
  NightShiftApplySend,
  NightShiftRefused,
  StagedAction,
} from "../schemas/night-shift.ts";
import { ApprovalRequest } from "../schemas/permissions.ts";
import { PlanFork, PlanForkBranch, PlanForkOption } from "../schemas/plan-forks.ts";
import { SurfaceAnswerToken } from "./approvals.ts";
import { defineMethod } from "./define.ts";

const Options = Type.Array(PlanForkOption, { minItems: 2, maxItems: 4 });
const ForkWithBranches = Type.Object({
  fork: PlanFork,
  branches: Type.Array(PlanForkBranch, { maxItems: 4 }),
});

/** `planForks.*` (docs/design/fork-a-plan-2026.md §7.2). */
export const PlanForksMethods = {
  "planForks.suggest": defineMethod({
    params: Type.Object({ threadId: Id, messageId: Id }),
    result: Type.Object({ options: Type.Array(PlanForkOption, { maxItems: 2 }) }),
    scope: "operator.write",
    callsModel: true,
    description:
      "Suggests two options for the start sheet from the thread, with one utility-model call. Nothing is stored; the owner edits the suggestion before starting.",
  }),
  "planForks.estimate": defineMethod({
    params: Type.Object({ threadId: Id, branches: Options }),
    result: Type.Object({
      /** Worst case in dollars from the model's prices and the caps; null for an unpriced model. */
      maxUsd: Nullable(Type.Number({ minimum: 0 })),
      /** Worst-case tokens; shown for an unpriced or local model. */
      maxTokens: Type.Integer({ minimum: 0 }),
      budgetUsd: Type.Number({ minimum: 0 }),
    }),
    scope: "operator.read",
    description:
      "The worst-case cost of forking this thread into these options: 'Up to about $0.40'.",
  }),
  "planForks.create": defineMethod({
    params: Type.Object({ threadId: Id, messageId: Id, branches: Options }),
    result: ForkWithBranches,
    scope: "operator.write",
    sideEffecting: true,
    callsModel: true,
    description:
      "Forks the thread at the message: one hidden branch thread and one task per option, each working its option out read-only. Refused on incognito, channel, automation and subagent threads, while a run is writing, and while another fork of the thread runs. Side-effecting: requires idempotencyKey.",
  }),
  "planForks.get": defineMethod({
    params: Type.Object({ forkId: Id }),
    result: ForkWithBranches,
    scope: "operator.read",
    description:
      "One fork with its branches and the comparison. For a caller that is not the desktop shell, items that cite owner-only sources, totals that include them and model-written text are withheld (each branch's scrub says how much).",
  }),
  "planForks.staged": defineMethod({
    params: Type.Object({ forkId: Id, branchId: Id }),
    result: Type.Object({ items: Type.Array(StagedAction, { maxItems: 50 }) }),
    scope: "operator.read",
    description:
      "The prepared items of one branch (previews, binding hashes, send hashes) for the Take sheet. Scrubbed like planForks.get for a caller that is not the desktop shell: withheld items carry no summary, preview or params.",
  }),
  "planForks.list": defineMethod({
    params: Type.Object({ threadId: Id }),
    result: Type.Object({ forks: Type.Array(PlanFork, { maxItems: 50 }) }),
    scope: "operator.read",
    description: "The forks of a thread, newest first, without branches.",
  }),
  "planForks.cancel": defineMethod({
    params: Type.Object({ forkId: Id, branchId: Type.Optional(Id) }),
    result: Type.Object({ cancelled: Type.Integer({ minimum: 0 }) }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Stops one branch, or every branch when branchId is absent. Filed reports are kept and staged items are dismissed. Side-effecting: requires idempotencyKey.",
  }),
  "planForks.retryBranch": defineMethod({
    params: Type.Object({ forkId: Id, branchId: Id }),
    result: Type.Object({ branch: PlanForkBranch }),
    scope: "operator.write",
    sideEffecting: true,
    callsModel: true,
    description:
      "Re-queues a failed branch, once per branch and only within what is left of the fork's budget. Side-effecting: requires idempotencyKey.",
  }),
  "planForks.take": defineMethod({
    params: Type.Object({
      forkId: Id,
      branchId: Id,
      items: Type.Array(NightShiftApplyItem, { maxItems: 50 }),
      /** Sends are separate from `items`: selecting every item never sends. */
      sends: Type.Array(NightShiftApplySend, { maxItems: 50 }),
      /** Start one parent turn with the remaining Psyche steps once the plan is taken. */
      continue: Type.Boolean(),
    }),
    result: Type.Object({
      approval: Type.Optional(ApprovalRequest),
      answerToken: Type.Optional(SurfaceAnswerToken),
      refused: Type.Array(NightShiftRefused),
    }),
    scope: "operator.approvals",
    sideEffecting: true,
    description:
      "Takes one branch's plan: requests the one staged_apply approval for the ticked items, bound to their binding hashes. With no items there is no approval and the plan is taken at once. The client must check the approval's item hashes equal its selection before approvals.answer. Side-effecting: requires idempotencyKey; a replay returns the same approval and token.",
  }),
  "planForks.dismiss": defineMethod({
    params: Type.Object({ forkId: Id }),
    result: Type.Object({ dismissed: Type.Boolean() }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Ends a ready fork and dismisses its staged items. Runs nothing. Side-effecting: requires idempotencyKey.",
  }),
};
