import type { ApprovalKind, RiskClass, SideEffect } from "@psyche/protocol";
import type { ClassifierLabel } from "./types.ts";

/**
 * The risk class of an approval card (the automation digest's "Approve all routine ones").
 *
 * `routine` is deliberately narrow: a kind the owner could safely approve in bulk, with no side
 * effect beyond a local write, no taint, no payment and no classifier objection. Everything else
 * is `sensitive`, so the bulk button never covers it. This only labels cards; it does not change
 * which actions ask for approval or what an approval allows.
 */
export const ROUTINE_BULK_KINDS: ReadonlySet<ApprovalKind> = new Set<ApprovalKind>([
  "file_write",
  "git_write",
  "archive_thread",
  "task_start",
]);

const ROUTINE_SIDE_EFFECTS: ReadonlySet<SideEffect> = new Set<SideEffect>([
  "none",
  "read",
  "write",
]);

export function riskClassFor(input: {
  kind: ApprovalKind;
  sideEffect?: SideEffect | undefined;
  requiresAuthentication: boolean;
  taint: boolean;
  classifierLabel?: ClassifierLabel | undefined;
}): RiskClass {
  if (input.classifierLabel === "prohibited") return "prohibited";
  if (input.classifierLabel === "sensitive") return "sensitive";
  if (input.requiresAuthentication || input.taint) return "sensitive";
  if (input.sideEffect === undefined || !ROUTINE_SIDE_EFFECTS.has(input.sideEffect))
    return "sensitive";
  return ROUTINE_BULK_KINDS.has(input.kind) ? "routine" : "sensitive";
}
