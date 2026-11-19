import { type ApprovalRequest, type DeferralTask, isUnattendedTask } from "@psyche/protocol";
import type { ApprovalView } from "../data/hooks.ts";

/** The only kinds the broker ever classes routine (packages/permissions risk.ts). */
const ROUTINE_KINDS: ReadonlySet<string> = new Set(["file_write", "git_write"]);

/**
 * A card that may show as a compact Deferred row: the broker classed it `routine`, and nothing
 * on it needs the full card (no payment, no device-only card, no typed word, no folder picker or
 * compose editor). Every other card keeps the full ApprovalCard with all its gates.
 */
export function isCompactRoutine(a: ApprovalRequest): boolean {
  return (
    a.status === "pending" &&
    a.riskClass === "routine" &&
    ROUTINE_KINDS.has(a.kind) &&
    a.requiresAuthentication === false &&
    a.deviceOnly !== true &&
    a.details.confirmationWord === undefined
  );
}

/**
 * The cards "Approve all routine ones" covers: compact routine cards with an answer token on this
 * window. The Gateway checks each one again (`bulk: true`) and refuses any it did not class
 * routine, so this filter is not the only gate.
 */
export function routineDeferred(views: readonly ApprovalView[]): ApprovalView[] {
  return views.filter((v) => isCompactRoutine(v.approval) && v.canAnswer && !v.stale);
}

/** The path a write row shows in full (never a basename): the card's target, or its repo. */
export function writePath(a: ApprovalRequest): string | undefined {
  if (a.target?.kind === "path" && a.target.value !== "") return a.target.value;
  const repo = a.details.repo;
  return typeof repo === "string" && repo !== "" ? repo : undefined;
}

/**
 * Full cards (Needs you) and the digest's rows (Deferred). Deferred holds only an unattended run's
 * cards that are compact routine ones this window can answer, or ones answered on another device.
 * Every other card, sensitive ones included, stays a full card. `needsYou` counts every card this
 * window can answer (the badge and Home), so a Deferred row is never left out of the count.
 */
export function splitApprovals(
  pending: readonly ApprovalView[],
  tasks: Readonly<Record<string, DeferralTask | undefined>>,
): { live: ApprovalView[]; deferred: ApprovalView[]; needsYou: number } {
  const live: ApprovalView[] = [];
  const deferred: ApprovalView[] = [];
  for (const v of pending) {
    const taskId = v.approval.requestedBy.taskId;
    const task = taskId == null ? undefined : tasks[taskId];
    // An automation's run, or a specialist an automation started (no parent run, §4.10).
    if (!isUnattendedTask(task)) live.push(v);
    else if (!v.canAnswer) deferred.push(v);
    else if (isCompactRoutine(v.approval) && !v.stale) deferred.push(v);
    else live.push(v);
  }
  return { live, deferred, needsYou: live.length + deferred.filter((v) => v.canAnswer).length };
}
