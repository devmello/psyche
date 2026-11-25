import type { ForkReport, PlanComparison } from "@psyche/protocol";
import { type BranchReport, dimensionDiffers, fallbackComparison, itemsOf } from "./comparison.ts";
import { numbersIn, roundValue, scanNumbers } from "./report-check.ts";

/**
 * Checks the comparison pass's output like a report (docs/design/fork-a-plan-2026.md §4.3). The
 * model's answer is a set of pointers plus short notes: every pointer must land on a real item of
 * the right branch and dimension, and no text may state a number the reports lack. `differs` is
 * recomputed in code. If nothing survives, the caller shows `fallbackComparison` instead.
 */

/** Phrases that pick a branch for the owner. The comparison never recommends. */
const RECOMMENDS =
  /\b(you\s+should|you\s+must|you\s+ought|you\s+need\s+to|i\s+(?:would\s+)?recommend|we\s+recommend|i\s+suggest|go\s+with|choose|pick)\b/i;

/** Every number an item states: its fields as text, plus date parts, never its id or cites. */
function itemNumbers(item: object): Set<number> {
  const {
    id: _i,
    cites: _c,
    unsourced: _u,
    stagedId: _s,
    personId: _p,
    ...rest
  } = item as Record<string, unknown>;
  const out = new Set<number>();
  const visit = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) out.add(roundValue(Math.abs(v)));
    else if (typeof v === "string") {
      for (const n of numbersIn(v)) out.add(n);
      for (const m of v.matchAll(/(?<![0-9])\d{4}-\d{2}-\d{2}(?![0-9])/g)) {
        for (const part of m[0].split("-")) out.add(Number(part));
      }
    } else if (Array.isArray(v)) v.forEach(visit);
  };
  Object.values(rest).forEach(visit);
  return out;
}

function reportNumbers(report: ForkReport): Set<number> {
  const out = new Set<number>();
  for (const n of numbersIn(report.summary)) out.add(n);
  for (const key of [
    "steps",
    "costs",
    "dates",
    "people",
    "tradeoffs",
    "risks",
    "openQuestions",
  ] as const) {
    for (const item of report[key]) for (const n of itemNumbers(item)) out.add(n);
  }
  return out;
}

/**
 * True when `text` states no number outside `allowed`. An ISO date must be made of allowed parts,
 * and a digit run the number reader cannot place (`msg_185`, `185px`) counts as invented.
 */
function onlyNumbers(text: string, allowed: ReadonlySet<number>): boolean {
  for (const m of text.matchAll(/(?<![0-9])(\d{4})-(\d{2})-(\d{2})(?![0-9])/g)) {
    for (const part of [m[1], m[2], m[3]]) if (!allowed.has(Number(part))) return false;
  }
  const { values, rest } = scanNumbers(text);
  for (const n of values) if (!allowed.has(n)) return false;
  return !/\d/.test(rest);
}

export interface ComparisonCheckResult {
  comparison: PlanComparison;
  /** Nothing usable survived; `comparison` is the code-computed fallback. */
  usedFallback: boolean;
  dropped: { rows: number; cells: number; notes: number; betterIf: number; headline: boolean };
}

export function checkComparison(
  raw: PlanComparison | null,
  branches: readonly BranchReport[],
): ComparisonCheckResult {
  const dropped = { rows: 0, cells: 0, notes: 0, betterIf: 0, headline: false };
  const fallback = (): ComparisonCheckResult => ({
    comparison: fallbackComparison(branches),
    usedFallback: true,
    dropped,
  });
  if (raw === null) return fallback();

  const byId = new Map(branches.map((b) => [b.branchId, b]));
  const perBranchNumbers = new Map(branches.map((b) => [b.branchId, reportNumbers(b.report)]));
  const allNumbers = new Set<number>();
  for (const s of perBranchNumbers.values()) for (const n of s) allNumbers.add(n);

  const rows: PlanComparison["rows"] = [];
  for (const row of raw.rows) {
    const cells: PlanComparison["rows"][number]["cells"] = [];
    const seen = new Set<string>();
    for (const cell of row.cells) {
      const branch = byId.get(cell.branchId);
      if (!branch || seen.has(cell.branchId)) {
        dropped.cells += 1;
        continue;
      }
      const have = new Set(itemsOf(branch.report, row.dimension).map((it) => it.id));
      const ids = new Set(cell.itemIds);
      if (ids.size !== cell.itemIds.length || cell.itemIds.some((id) => !have.has(id))) {
        dropped.cells += 1;
        continue;
      }
      seen.add(cell.branchId);
      const items = itemsOf(branch.report, row.dimension).filter((it) => ids.has(it.id));
      const allowed = new Set<number>();
      for (const it of items) for (const n of itemNumbers(it)) allowed.add(n);
      const next: PlanComparison["rows"][number]["cells"][number] = {
        branchId: cell.branchId,
        itemIds: cell.itemIds,
      };
      if (cell.note !== undefined && cell.note.trim() !== "") {
        if (onlyNumbers(cell.note, allowed) && !RECOMMENDS.test(cell.note)) next.note = cell.note;
        else dropped.notes += 1;
      }
      cells.push(next);
    }
    const labelOk = onlyNumbers(row.label, allNumbers) && !RECOMMENDS.test(row.label);
    if (!labelOk || !cells.some((c) => c.itemIds.length > 0)) {
      dropped.rows += 1;
      continue;
    }
    rows.push({
      dimension: row.dimension,
      label: row.label,
      cells,
      differs: dimensionDiffers(
        row.dimension,
        branches.map((b) => ({
          report: b.report,
          itemIds: cells.find((c) => c.branchId === b.branchId)?.itemIds ?? [],
        })),
      ),
    });
  }

  const betterIf: PlanComparison["betterIf"] = [];
  for (const b of raw.betterIf) {
    const nums = perBranchNumbers.get(b.branchId);
    if (
      nums === undefined ||
      betterIf.some((x) => x.branchId === b.branchId) ||
      !onlyNumbers(b.text, nums) ||
      RECOMMENDS.test(b.text)
    ) {
      dropped.betterIf += 1;
      continue;
    }
    betterIf.push(b);
  }

  let headline = raw.headline;
  if (!onlyNumbers(headline, allNumbers) || RECOMMENDS.test(headline)) {
    headline = "";
    dropped.headline = true;
  }

  if (rows.length === 0) return fallback();
  return { comparison: { headline, rows, betterIf }, usedFallback: false, dropped };
}
