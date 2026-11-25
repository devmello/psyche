import type { ForkCost, ForkDateItem, ForkPerson, ForkReport } from "@psyche/protocol";

/**
 * Numbers that come from code, not the model (docs/design/fork-a-plan-2026.md §4.3): totals per
 * currency and per period, the earliest deadline, and people aligned across branches. Costs in
 * different currencies or periods are never added together, and nothing is converted.
 */

export type CostPeriod = ForkCost["period"];

export interface CostTotal {
  currency: string;
  period: CostPeriod;
  amount: number;
  /** Any part of this total is an estimate. */
  includesEstimate: boolean;
  count: number;
}

const PERIOD_ORDER: Record<CostPeriod, number> = { once: 0, month: 1, year: 2 };

/** Sums in whole cents so 0.1 + 0.2 reads as 0.3. Non-finite amounts are skipped. */
export function computeTotals(costs: readonly ForkCost[]): CostTotal[] {
  const groups = new Map<
    string,
    { currency: string; period: CostPeriod; cents: number; est: boolean; n: number }
  >();
  for (const c of costs) {
    if (!Number.isFinite(c.amount)) continue;
    const currency = c.currency.toUpperCase();
    const key = `${currency}|${c.period}`;
    const g = groups.get(key) ?? { currency, period: c.period, cents: 0, est: false, n: 0 };
    g.cents += Math.round(c.amount * 100);
    g.est ||= c.estimate;
    g.n += 1;
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        a.currency.localeCompare(b.currency) || PERIOD_ORDER[a.period] - PERIOD_ORDER[b.period],
    )
    .map((g) => ({
      currency: g.currency,
      period: g.period,
      amount: g.cents / 100,
      includesEstimate: g.est,
      count: g.n,
    }));
}

/** The earliest `deadline` item by calendar day (ties keep report order); null when none. */
export function earliestDeadline(dates: readonly ForkDateItem[]): ForkDateItem | null {
  let best: ForkDateItem | null = null;
  for (const d of dates) {
    if (d.kind !== "deadline") continue;
    if (best === null || d.date.slice(0, 10) < best.date.slice(0, 10)) best = d;
  }
  return best;
}

export interface AlignedPerson {
  /** Null for people with no resolved Memory id: they are never merged by name. */
  personId: string | null;
  name: string;
  cells: { branchId: string; itemIds: string[] }[];
}

/** Aligns people across branches by `personId` only. Unlinked people each get their own row. */
export function alignPeople(
  branches: readonly { branchId: string; people: readonly ForkPerson[] }[],
): AlignedPerson[] {
  const rows: AlignedPerson[] = [];
  const linked = new Map<string, AlignedPerson>();
  for (const b of branches) {
    for (const p of b.people) {
      if (p.personId === undefined) {
        rows.push({
          personId: null,
          name: p.name,
          cells: [{ branchId: b.branchId, itemIds: [p.id] }],
        });
        continue;
      }
      let row = linked.get(p.personId);
      if (!row) {
        row = { personId: p.personId, name: p.name, cells: [] };
        linked.set(p.personId, row);
        rows.push(row);
      }
      const cell = row.cells.find((c) => c.branchId === b.branchId);
      if (cell) cell.itemIds.push(p.id);
      else row.cells.push({ branchId: b.branchId, itemIds: [p.id] });
    }
  }
  return rows;
}

export interface BranchTotals {
  branchId: string;
  costs: CostTotal[];
  earliestDeadline: { id: string; label: string; date: string } | null;
}

export function branchTotals(branchId: string, report: ForkReport): BranchTotals {
  const d = earliestDeadline(report.dates);
  return {
    branchId,
    costs: computeTotals(report.costs),
    earliestDeadline: d ? { id: d.id, label: d.label, date: d.date } : null,
  };
}
