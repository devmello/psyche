import type { ApprovalRequest } from "@psyche/protocol";

type Waitable = Pick<ApprovalRequest, "status" | "expiresAt">;

/**
 * Does this approval still wait on the owner? Pending in the store and, when a clock is given,
 * not past its expiry: an expired request is history ("Missed ..."), never "Needs you", even in
 * the moment between its deadline and the Gateway's `approval.updated` saying so. Without `now`
 * only the status counts (the header and the inspector, whose lists are the store's pending set).
 */
export function approvalWaits(approval: Waitable, now?: number): boolean {
  if (approval.status !== "pending") return false;
  if (now === undefined) return true;
  const expires = Date.parse(approval.expiresAt);
  return Number.isNaN(expires) || expires > now;
}

/** Approvals still waiting plus open questions: the count the header and the inspector show. */
export function countWaiting(
  approvals: Readonly<Record<string, Waitable>>,
  questions: Readonly<Record<string, { status: string }>>,
  now?: number,
): number {
  const a = Object.values(approvals).filter((x) => approvalWaits(x, now)).length;
  const q = Object.values(questions).filter((x) => x.status === "open").length;
  return a + q;
}
