import type {
  ForkCite,
  ForkReport,
  PlanComparison,
  PlanForkBranch,
  PlanForkScrub,
} from "@psyche/protocol";
import { itemsOf } from "./comparison.ts";
import { OWNER_ONLY_SOURCES } from "./report-check.ts";
import { type CostTotal, computeTotals } from "./totals.ts";

/**
 * Remote viewers (docs/design/fork-a-plan-2026.md §4.4). `planForks.get` runs a fork through
 * `scrubForViewer` for every connection that is not the desktop shell. Withheld text is replaced
 * by an empty string plus a flag, so the client shows its own localised "Open on your Mac to read
 * this"; withheld content never reaches the caller at all. Fails closed: anything other than the
 * exact desktop-shell viewer is treated as remote.
 */

export type Viewer = { kind: "desktop-shell" } | { kind: "remote" };

export function isDesktopShell(viewer: Viewer | undefined): boolean {
  return viewer?.kind === "desktop-shell";
}

export interface ForkView {
  branches: readonly PlanForkBranch[];
  comparison: PlanComparison | null;
}

export interface BranchTotalsView {
  branchId: string;
  /** Null when a cost in the totals is withheld: "Total on your Mac". */
  costs: CostTotal[] | null;
}

export interface ScrubbedForkView {
  branches: PlanForkBranch[];
  comparison: PlanComparison | null;
  totals: BranchTotalsView[];
  scrub: PlanForkScrub;
}

const NO_SCRUB: PlanForkScrub = { hiddenItems: 0, textHidden: false, totalsHidden: false };

/** Any cite from an owner-only source: the item is withheld whole. */
export function hasOwnerOnlyCite(cites: readonly ForkCite[]): boolean {
  return cites.some((c) => c.source !== undefined && OWNER_ONLY_SOURCES.has(c.source));
}

/**
 * A cited item is withheld when any cite is owner-only. When the branch read an owner-only
 * source, an item with no valid cite is withheld too: nothing proves where its text came from.
 */
function cited<T extends { cites: readonly ForkCite[] }>(
  items: readonly T[],
  readOwnerOnly: boolean,
): { kept: T[]; hidden: number } {
  const kept = items.filter(
    (it) => !hasOwnerOnlyCite(it.cites) && !(readOwnerOnly && it.cites.length === 0),
  );
  return { kept, hidden: items.length - kept.length };
}

function scrubReport(
  report: ForkReport,
  readOwnerOnly: boolean,
): { report: ForkReport; hidden: number; hiddenCosts: number } {
  const costs = cited(report.costs, readOwnerOnly);
  const dates = cited(report.dates, readOwnerOnly);
  const people = cited(report.people, readOwnerOnly);
  const tradeoffs = cited(report.tradeoffs, readOwnerOnly);
  const risks = cited(report.risks, readOwnerOnly);
  // Steps and open questions carry no cites, so a branch that read owner-only data cannot show
  // them: their text may echo it.
  const steps = readOwnerOnly ? [] : report.steps;
  const questions = readOwnerOnly ? [] : report.openQuestions;
  const hidden =
    costs.hidden +
    dates.hidden +
    people.hidden +
    tradeoffs.hidden +
    risks.hidden +
    (report.steps.length - steps.length) +
    (report.openQuestions.length - questions.length);
  return {
    report: {
      summary: readOwnerOnly ? "" : report.summary,
      steps,
      costs: costs.kept,
      dates: dates.kept,
      people: people.kept,
      tradeoffs: tradeoffs.kept,
      risks: risks.kept,
      openQuestions: questions,
    },
    hidden,
    hiddenCosts: costs.hidden,
  };
}

export function scrubForViewer(view: ForkView, viewer: Viewer | undefined): ScrubbedForkView {
  const totalOf = (b: PlanForkBranch): BranchTotalsView => ({
    branchId: b.id,
    costs: b.report ? computeTotals(b.report.costs) : [],
  });
  if (isDesktopShell(viewer)) {
    return {
      branches: [...view.branches],
      comparison: view.comparison,
      totals: view.branches.map(totalOf),
      scrub: NO_SCRUB,
    };
  }

  let hiddenItems = 0;
  let textHidden = false;
  let totalsHidden = false;
  const visibleIds = new Map<string, ForkReport>();
  const totals: BranchTotalsView[] = [];
  const ownerBranches = new Set<string>();

  const branches = view.branches.map((b): PlanForkBranch => {
    if (b.readOwnerOnly) ownerBranches.add(b.id);
    if (b.report === null || b.report === undefined) {
      totals.push({ branchId: b.id, costs: [] });
      return { ...b, scrub: NO_SCRUB };
    }
    const s = scrubReport(b.report, b.readOwnerOnly);
    visibleIds.set(b.id, s.report);
    hiddenItems += s.hidden;
    textHidden ||= b.readOwnerOnly;
    totalsHidden ||= s.hiddenCosts > 0;
    totals.push({
      branchId: b.id,
      costs: s.hiddenCosts > 0 ? null : computeTotals(s.report.costs),
    });
    return {
      ...b,
      report: s.report,
      // The branch's own error text and taint sources can quote what it read.
      error: b.readOwnerOnly ? null : b.error,
      scrub: {
        hiddenItems: s.hidden,
        textHidden: b.readOwnerOnly,
        totalsHidden: s.hiddenCosts > 0,
      },
    };
  });

  let comparison: PlanComparison | null = null;
  if (view.comparison !== null) {
    const anyOwner = ownerBranches.size > 0;
    textHidden ||= anyOwner;
    comparison = {
      headline: anyOwner ? "" : view.comparison.headline,
      rows: view.comparison.rows.map((row) => ({
        ...row,
        // A cell that names an item the viewer cannot see loses it; its note goes with the branch.
        label: anyOwner ? "" : row.label,
        cells: row.cells.map((cell) => {
          const shown = visibleIds.get(cell.branchId);
          const ids = new Set(shown ? itemsOf(shown, row.dimension).map((i) => i.id) : []);
          const { note: _note, ...rest } = cell;
          const next = { ...rest, itemIds: cell.itemIds.filter((id) => ids.has(id)) };
          return ownerBranches.has(cell.branchId) || cell.note === undefined
            ? next
            : { ...next, note: cell.note };
        }),
      })),
      betterIf: view.comparison.betterIf.map((b) =>
        ownerBranches.has(b.branchId) ? { ...b, text: "" } : b,
      ),
    };
  }

  return {
    branches,
    comparison,
    totals,
    scrub: { hiddenItems, textHidden, totalsHidden },
  };
}
