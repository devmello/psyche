import type { ApprovalKind } from "@psyche/protocol";
import { isMoneyText, isMoneyToolName } from "@psyche/protocol/money-intent";
import { AUTH_KINDS, DEVICE_ONLY_KINDS, inferApprovalKind, SEVERITY } from "./kinds.ts";
import type { PolicyDecision, StagedApplyChildInput, StagedApplyRefusalReason } from "./types.ts";

/**
 * Per-child rules of `requestStagedApply` (docs/design/night-shift-2026.md §3.1, §3.2, §5.4).
 * Pure: the broker passes the child and the decision it just made, and gets back why the child
 * is left out of the approval, or undefined when it may stay.
 */

/** Destructive tools an undo may call, matched on the last name segment (`apple.calendar_delete_event`). */
const UNDO_DESTRUCTIVE_TOOLS = new Set(["calendar_delete_event", "reminders_delete"]);

const MAX_STRINGS = 500;
const MAX_DEPTH = 8;

/** Every string a call carries (params, keys and extras), bounded, for the money-intent text check. */
export function callStrings(
  params: unknown,
  extra: readonly (string | undefined)[] = [],
): { strings: string[]; truncated: boolean } {
  const out: string[] = extra.filter((s): s is string => typeof s === "string");
  let truncated = false;
  const walk = (v: unknown, depth: number): void => {
    if (out.length >= MAX_STRINGS || depth > MAX_DEPTH) {
      truncated = true;
      return;
    }
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (typeof v === "object" && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        out.push(k);
        walk(x, depth + 1);
      }
    }
  };
  walk(params, 0);
  return { strings: out, truncated };
}

/** Whether `needle` is one of the string values (or keys) of a call's params. */
function carriesString(params: unknown, needle: string): boolean {
  return callStrings(params).strings.includes(needle);
}

export function lastSegment(tool: string): string {
  const parts = tool.split(/[.:]|__/);
  return parts[parts.length - 1] ?? tool;
}

/** The money check of §3.1: tool name, summary, and every string the call carries. */
export function stagedMoneyIntent(child: StagedApplyChildInput, tool: string): boolean {
  if (isMoneyToolName(tool) || isMoneyToolName(child.call.tool)) return true;
  if (isMoneyText(child.summary)) return true;
  const { strings, truncated } = callStrings(child.call.params, [child.call.target?.value]);
  // A call too big to read in full fails closed.
  if (truncated) return true;
  return strings.some((s) => isMoneyText(s));
}

/** The kinds a child can be read as: the resolved one, the decision's, the declared and the inferred. */
export function stagedKinds(
  child: StagedApplyChildInput,
  d: PolicyDecision,
  kind: ApprovalKind,
): Set<ApprovalKind> {
  return new Set<ApprovalKind>([
    kind,
    ...(d.approvalKind === undefined ? [] : [d.approvalKind]),
    ...(child.call.kind === undefined ? [] : [child.call.kind]),
    inferApprovalKind(child.call.tool),
    inferApprovalKind(d.call.tool),
  ]);
}

export interface StagedVerdict {
  reason: StagedApplyRefusalReason;
  message: string;
}

/**
 * Why a decided child is refused, or undefined when it may be part of the approval.
 * `kind` is the broker's resolved kind; the declared and inferred kinds are checked too, so a
 * relabelled call (`kind: "file_write"` on a send) still meets every rule.
 */
export function refuseStagedChild(
  child: StagedApplyChildInput,
  d: PolicyDecision,
  kind: ApprovalKind,
): StagedVerdict | undefined {
  const tool = d.call.tool;
  const kinds = stagedKinds(child, d, kind);
  const any = (list: readonly ApprovalKind[]): boolean => [...kinds].some((k) => list.includes(k));
  const se = d.sideEffect;

  // §3.1.
  if (stagedMoneyIntent(child, tool)) {
    return { reason: "money_intent", message: "this looks like a payment" };
  }
  if (d.decision === "deny") {
    return { reason: "denied", message: `denied: ${d.reason ?? d.rule}` };
  }
  if (se === "financial" || child.call.sideEffect === "financial") {
    return { reason: "financial", message: "payments are never applied in bulk" };
  }
  if (kinds.has("purchase")) {
    return { reason: "purchase", message: "purchases are never applied in bulk" };
  }
  if (any(AUTH_KINDS)) {
    return { reason: "authentication", message: "this needs its own approval" };
  }
  if (d.typedConfirmation !== undefined) {
    return { reason: "typed_confirmation", message: "this needs a typed confirmation" };
  }
  if (kinds.has("batch") || kinds.has("staged_apply")) {
    return { reason: "nested_approval", message: "an approval can't hold another approval" };
  }
  if (any(DEVICE_ONLY_KINDS)) {
    return { reason: "device_only_kind", message: "this needs its own approval on the Mac" };
  }

  // §3.2: a send only when the owner ticked it and it says who gets it.
  if (kinds.has("send_email")) {
    const recipients = child.recipients;
    const explicit =
      child.explicitSend === true &&
      child.undo === undefined &&
      Array.isArray(recipients) &&
      recipients.length > 0 &&
      recipients.every((r) => typeof r === "string" && r.trim() !== "");
    if (!explicit) {
      return {
        reason: "send_not_explicit",
        message: "a send needs its own tick and its recipients",
      };
    }
    return undefined;
  }

  // §5.4: a destructive child is only an undo of something Night shift created.
  if (SEVERITY[se] >= SEVERITY.destructive) {
    if (child.undo === undefined) {
      return { reason: "destructive", message: "deletes are never applied in bulk" };
    }
    const created = child.undo.createdId;
    if (
      typeof created !== "string" ||
      created === "" ||
      !UNDO_DESTRUCTIVE_TOOLS.has(lastSegment(tool)) ||
      !carriesString(d.call.params, created)
    ) {
      return {
        reason: "undo_unbound",
        message: "an undo may only delete what Night shift created",
      };
    }
    return undefined;
  }
  if (se !== "write") {
    return { reason: "not_write", message: "only changes can be applied" };
  }
  return undefined;
}
