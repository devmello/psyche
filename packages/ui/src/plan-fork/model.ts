import type {
  ApprovalRequest,
  ForkCost,
  ForkDateItem,
  ForkReport,
  PlanForkBranch,
  PlanForkStatus,
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
  /** The card lists an item the owner did not tick. */
  | "extra"
  /** An item the owner ticked is not on the card. */
  | "missing"
  /** An item appears twice, on the card or in the selection. */
  | "repeated"
  /** The same item with another binding hash than the owner saw. */
  | "changed"
  /** The card sends an item whose send box is not ticked, or the other way round. */
  | "send_mismatch"
  /** The card has no readable item list. */
  | "unreadable";

export type ApprovalCheck = { ok: true } | { ok: false; reason: ApprovalMismatch };

interface CardItem {
  itemId: string;
  bindingHash: string;
  send: boolean;
}

function cardItems(approval: Pick<ApprovalRequest, "details">): CardItem[] | null {
  const raw = (approval.details as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(raw)) return null;
  const out: CardItem[] = [];
  for (const r of raw) {
    if (typeof r !== "object" || r === null) return null;
    const o = r as { itemId?: unknown; bindingHash?: unknown; send?: unknown };
    if (typeof o.itemId !== "string" || typeof o.bindingHash !== "string") return null;
    out.push({ itemId: o.itemId, bindingHash: o.bindingHash, send: o.send !== undefined });
  }
  return out;
}

/**
 * The client's check before `approvals.answer`: the approval's item set must equal what the owner
 * ticked, exactly. An extra, missing, repeated or changed hash, or a card of another kind, is
 * refused and nothing is answered. Order does not matter. A send on the card needs its own tick.
 */
export function checkApproval(
  approval: Pick<ApprovalRequest, "kind" | "details">,
  selection: TakeSelection,
): ApprovalCheck {
  if (approval.kind !== "staged_apply") return { ok: false, reason: "wrong_kind" };
  const card = cardItems(approval);
  if (card === null) return { ok: false, reason: "unreadable" };
  const ticked = new Map<string, string>();
  for (const i of selection.items) {
    if (ticked.has(i.itemId)) return { ok: false, reason: "repeated" };
    ticked.set(i.itemId, i.bindingHash);
  }
  const sends = new Set<string>();
  for (const s of selection.sends) {
    if (sends.has(s.itemId)) return { ok: false, reason: "repeated" };
    if (!ticked.has(s.itemId)) return { ok: false, reason: "send_mismatch" };
    sends.add(s.itemId);
  }
  const seen = new Set<string>();
  for (const c of card) {
    if (seen.has(c.itemId)) return { ok: false, reason: "repeated" };
    seen.add(c.itemId);
    const hash = ticked.get(c.itemId);
    if (hash === undefined) return { ok: false, reason: "extra" };
    if (hash !== c.bindingHash) return { ok: false, reason: "changed" };
    if (c.send !== sends.has(c.itemId)) return { ok: false, reason: "send_mismatch" };
  }
  for (const id of ticked.keys()) if (!seen.has(id)) return { ok: false, reason: "missing" };
  return { ok: true };
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
