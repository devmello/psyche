import type { ApprovalView } from "../data/hooks.ts";

/**
 * The cards "Approve all routine ones" covers: broker-classed `routine`, no payment, and an
 * answer token on this window. Sensitive and prohibited cards never match, so they always need
 * their own tap. Payments follow the existing presence path inside `answerApproval`.
 */
export function routineDeferred(views: readonly ApprovalView[]): ApprovalView[] {
  return views.filter(
    (v) =>
      v.approval.status === "pending" &&
      v.approval.riskClass === "routine" &&
      v.approval.requiresAuthentication === false &&
      v.canAnswer &&
      !v.stale,
  );
}
