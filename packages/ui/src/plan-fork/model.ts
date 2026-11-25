import {
  type ApprovalRequest,
  type ForkCost,
  type ForkDateItem,
  type ForkReport,
  type PlanFork,
  type PlanForkBranch,
  type PlanForkStatus,
  stagedApplyMatchesSelection,
} from "@psyche/protocol";

/**
 * Pure rules of the Fork a plan screens (docs/design/fork-a-plan-2026.md §3.4, §4.3, §5.1, §6):
 * the approval hash check, totals computed in code, and what the card says about a fork's state.
 */

/** The selection the owner ticked in the Take sheet. Sends are listed apart from items. */
export interface TakeSelection {
  /** Every ticked staged item, bound to the hash the owner saw. */
  items: readonly { itemId: string; bindingHash: string }[];
  /** The items whose "Send it too" box is ticked. Never more than the owner ticked. */
  sends: readonly { itemId: string; sendHash: string }[];
}

export type ApprovalMismatch =
  /** Not a `staged_apply` card. */
  | "wrong_kind"
  /** The card's item bindings are not exactly what the owner ticked. */
  | "mismatch";

export type ApprovalCheck = { ok: true } | { ok: false; reason: ApprovalMismatch };

/**
 * `stagedApplyMatchesSelection`, the client's check before `approvals.answer` (the contract
 * `planForks.take` describes): the `staged_apply` approval's item binding hashes must equal
 * exactly the items the owner ticked, plus one `:send` child per ticked "Send it too". An extra,
 * missing, repeated or changed hash, or a card of another kind, means nothing is answered.
 */
export function checkApproval(
  approval: Pick<ApprovalRequest, "kind" | "details">,
  selection: TakeSelection,
): ApprovalCheck {
  if (approval.kind !== "staged_apply") return { ok: false, reason: "wrong_kind" };
  return stagedApplyMatchesSelection(approval.details, selection)
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}

/** One total of a branch: a currency and a period, with whether any part is an estimate. */
export interface CostTotal {
  currency: string;
  period: ForkCost["period"];
  amount: number;
  includesEstimate: boolean;
}

const PERIODS: readonly ForkCost["period"][] = ["once", "month", "year"];

/**
 * Totals per currency and period, summed here from the report's own items (§4.3: the model never
 * writes a number). Currencies are never converted.
 */
export function costTotals(costs: readonly ForkCost[]): CostTotal[] {
  const by = new Map<string, CostTotal>();
  for (const c of costs) {
    const key = `${c.currency}|${c.period}`;
    const cur = by.get(key);
    if (cur === undefined) {
      by.set(key, {
        currency: c.currency,
        period: c.period,
        amount: c.amount,
        includesEstimate: c.estimate,
      });
    } else {
      cur.amount += c.amount;
      cur.includesEstimate = cur.includesEstimate || c.estimate;
    }
  }
  return [...by.values()].sort(
    (a, b) =>
      a.currency.localeCompare(b.currency) || PERIODS.indexOf(a.period) - PERIODS.indexOf(b.period),
  );
}

/** The earliest deadline in a report, or null. Dates compare as ISO text. */
export function earliestDeadline(report: Pick<ForkReport, "dates">): ForkDateItem | null {
  let best: ForkDateItem | null = null;
  for (const d of report.dates) {
    if (d.kind !== "deadline") continue;
    if (best === null || d.date < best.date) best = d;
  }
  return best;
}

/** `PlanFork.error` of a taken plan whose parent turn could not start because the chat was busy. */
export const CONTINUE_PENDING = "continue_pending";

/** A taken plan waiting for its parent turn: the card shows Continue. */
export function continuePending(
  fork: Pick<PlanFork, "status" | "error" | "takenBranchId">,
): fork is Pick<PlanFork, "status" | "error"> & { takenBranchId: string } {
  return fork.status === "taken" && fork.takenBranchId != null && fork.error === CONTINUE_PENDING;
}

const LIVE: readonly PlanForkStatus[] = ["running", "comparing"];
export function isLive(status: PlanForkStatus): boolean {
  return LIVE.includes(status);
}

/** Whether the owner can take this branch's plan now. */
export function canTake(status: PlanForkStatus, branch: Pick<PlanForkBranch, "status">): boolean {
  return status === "ready" && branch.status === "reported";
}

/** Dollars as the start sheet and the card show them: cents under $10, whole dollars above. */
export function formatUsd(usd: number, locale?: string): string {
  const digits = usd < 10 ? 2 : 0;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(usd);
}

export function formatMoney(amount: number, currency: string, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** How many option rows the start sheet allows, and the text limits of a row. */
export const FORK_LIMITS = { minOptions: 2, maxOptions: 4, label: 40, premise: 280 } as const;

export interface OptionDraft {
  label: string;
  premise: string;
}

/** The options the sheet may start with: 2 to 4 rows, each with a label and a premise. */
export function readyOptions(options: readonly OptionDraft[]): OptionDraft[] | null {
  const rows = options.map((o) => ({ label: o.label.trim(), premise: o.premise.trim() }));
  if (rows.length < FORK_LIMITS.minOptions || rows.length > FORK_LIMITS.maxOptions) return null;
  for (const r of rows) {
    if (r.label === "" || r.label.length > FORK_LIMITS.label) return null;
    if (r.premise === "" || r.premise.length > FORK_LIMITS.premise) return null;
  }
  return rows;
}

/** `/compare Move to Austin | Stay`: the labels typed after the command, or none. */
export function parseCompareArg(arg: string): string[] {
  return arg
    .split("|")
    .map((s) => s.trim().slice(0, FORK_LIMITS.label))
    .filter((s) => s !== "")
    .slice(0, FORK_LIMITS.maxOptions);
}
