import type {
  ForkCite,
  ForkCiteSource,
  ForkCost,
  ForkDateItem,
  ForkPerson,
  ForkReport,
  ForkRisk,
  ForkTradeoff,
} from "@psyche/protocol";

/**
 * Checks a branch's `fork_report` before it is stored (docs/design/fork-a-plan-2026.md §4.2).
 * Pure: the caller hands in what the branch's run recorded. The model's own flags are never
 * trusted: a cite is valid only against a stored tool result, an amount or date stays "sure"
 * only if a valid cite's result contains it, and a `personId` or `stagedId` the caller cannot
 * confirm is dropped.
 */

/** One tool call of THIS branch's run, as recorded (never another branch's). */
export interface BranchCall {
  callId: string;
  /** The call ended `ok`. */
  ok: boolean;
  /** The tool's side-effect class; only `none` and `read` can back a cite. */
  sideEffect: string;
  /** The tool's class mapped to a cite source; null when it maps to none. */
  source: ForkCiteSource | null;
  /** The stored result, serialised. */
  result: string;
}

export interface ReportCheckContext {
  calls: readonly BranchCall[];
  /** True when the id resolves in Memory's people store. */
  resolvePerson: (personId: string) => boolean;
  /** Ids of this branch's live staged items. */
  liveStagedIds: ReadonlySet<string>;
}

export interface ReportCheckResult {
  report: ForkReport;
  /** The branch read Memory, Messages or Contacts through a tool, cited or not (§4.4). */
  readOwnerOnly: boolean;
  dropped: { cites: number; personIds: number; stagedIds: number; duplicateIds: number };
}

/** Sources only the desktop shell may see (§4.4). */
export const OWNER_ONLY_SOURCES: ReadonlySet<ForkCiteSource> = new Set([
  "memory",
  "messages",
  "contacts",
]);

const READ_CLASSES = new Set(["none", "read"]);
export const ESTIMATE_BASIS = "Psyche's estimate";

// ---------------------------------------------------------------------------------------------
// Text matching helpers (shared with comparison-check.ts)
// ---------------------------------------------------------------------------------------------

const ISO_DATE_TEXT = /\d{4}-\d{2}-\d{2}(?:T[0-9:.+\-Z]*)?/g;

export function roundValue(n: number): number {
  return Number(n.toFixed(6));
}

/**
 * Every number a text states, as values: `1,850`, `1850.00`, `$1.85k` and `1.2M` all read as what
 * they say. A digit run glued to letters or an id (`msg_185`, `185px`) is not a number, and an
 * ISO date is blanked first so `2026-06-01` states no 2026. `185` and `1,850` stay different.
 */
export function scanNumbers(text: string): { values: Set<number>; rest: string } {
  const values = new Set<number>();
  const blanked = text.replace(ISO_DATE_TEXT, " ");
  const re =
    /(?<![A-Za-z0-9_.,])(\d{1,3}(?:[,\u202f\u00a0]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)([kKmM])?(?![A-Za-z0-9_])/g;
  const rest = blanked.replace(re, (_all, num: string, suffix: string | undefined) => {
    let v = Number(num.replace(/[,\u202f\u00a0]/g, ""));
    if (!Number.isFinite(v)) return " ";
    const s = suffix?.toLowerCase();
    if (s === "k") v *= 1_000;
    else if (s === "m") v *= 1_000_000;
    values.add(roundValue(v));
    return " ";
  });
  return { values, rest };
}

export function numbersIn(text: string): Set<number> {
  return scanNumbers(text).values;
}

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};
const MONTH_RE =
  "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\\.?";

function ymd(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || y < 1000 || y > 9999) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Every calendar date a text states, as `YYYY-MM-DD`: ISO (with or without a time), "June 1,
 * 2026", "1st June 2026" and slash or dot dates. `06/01/2026` is ambiguous (June 1 or January 6),
 * so it counts only when the day is over 12 or both parts agree.
 */
export function datesIn(text: string): Set<string> {
  const out = new Set<string>();
  const add = (s: string | null) => {
    if (s) out.add(s);
  };
  for (const m of text.matchAll(/(?<![0-9])(\d{4})-(\d{2})-(\d{2})(?![0-9])/g)) {
    add(ymd(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  const mdy = new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi");
  for (const m of text.matchAll(mdy)) {
    add(ymd(Number(m[3]), MONTHS[(m[1] ?? "").toLowerCase()] ?? 0, Number(m[2])));
  }
  const dmy = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE},?\\s+(\\d{4})\\b`,
    "gi",
  );
  for (const m of text.matchAll(dmy)) {
    add(ymd(Number(m[3]), MONTHS[(m[2] ?? "").toLowerCase()] ?? 0, Number(m[1])));
  }
  for (const m of text.matchAll(/(?<![0-9/.])(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?![0-9])/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    if (a === b || (a > 12 && b <= 12)) add(ymd(y, b, a));
    else if (b > 12 && a <= 12) add(ymd(y, a, b));
  }
  return out;
}

const ID_KEY = /^(id|url|uri|href|link)$|(Id|_id|Url|_url|Uri|Href)$/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `ref` is an id field or URL in the stored result. Free text mentioning it does not count. */
export function refAppears(result: string, ref: string): boolean {
  if (ref.length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || parsed === null || typeof parsed !== "object") {
    return new RegExp(`(?<![A-Za-z0-9_\\-/])${escapeRe(ref)}(?![A-Za-z0-9_\\-])`).test(result);
  }
  const isUrl = /^https?:\/\//i.test(ref);
  const walk = (node: unknown, key: string): boolean => {
    if (typeof node === "string") return node === ref && (isUrl || ID_KEY.test(key));
    if (Array.isArray(node)) return node.some((n) => walk(n, key));
    if (node !== null && typeof node === "object") {
      return Object.entries(node).some(([k, v]) => walk(v, k));
    }
    return false;
  };
  return walk(parsed, "");
}

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

interface CitedItem {
  cites: ForkCite[];
  unsourced?: boolean | undefined;
}

export function checkReport(report: ForkReport, ctx: ReportCheckContext): ReportCheckResult {
  const byId = new Map<string, BranchCall>();
  for (const c of ctx.calls) if (!byId.has(c.callId)) byId.set(c.callId, c);
  const dropped = { cites: 0, personIds: 0, stagedIds: 0, duplicateIds: 0 };
  const seen = new Set<string>();

  const readOwnerOnly = ctx.calls.some(
    (c) => c.ok && READ_CLASSES.has(c.sideEffect) && c.source && OWNER_ONLY_SOURCES.has(c.source),
  );

  /** Valid cites with their source filled in, plus the result texts they point at. */
  const checkCites = (cites: readonly ForkCite[]): { cites: ForkCite[]; results: string[] } => {
    const kept: ForkCite[] = [];
    const results: string[] = [];
    for (const cite of cites) {
      const call = byId.get(cite.callId);
      if (
        !call ||
        !call.ok ||
        !READ_CLASSES.has(call.sideEffect) ||
        call.source === null ||
        !refAppears(call.result, cite.ref)
      ) {
        dropped.cites += 1;
        continue;
      }
      kept.push({ callId: cite.callId, ref: cite.ref, source: call.source });
      results.push(call.result);
    }
    return { cites: kept, results };
  };

  /** Keep the first item for an id; later ones with the same id are dropped. */
  const uniq = <T extends { id: string }>(items: readonly T[]): T[] =>
    items.filter((it) => {
      if (seen.has(it.id)) {
        dropped.duplicateIds += 1;
        return false;
      }
      seen.add(it.id);
      return true;
    });

  const markUnsourced = <T extends CitedItem>(item: T, cites: ForkCite[]): T => {
    const { unsourced: _drop, ...rest } = item;
    return (cites.length === 0 ? { ...rest, unsourced: true } : rest) as T;
  };

  const steps = uniq(report.steps).map((s) => {
    if (s.stagedId !== undefined && !ctx.liveStagedIds.has(s.stagedId)) {
      dropped.stagedIds += 1;
      const { stagedId: _s, ...rest } = s;
      return rest;
    }
    return s;
  });

  const costs = uniq(report.costs).map((c): ForkCost => {
    const { cites, results } = checkCites(c.cites);
    const sure =
      !c.estimate &&
      Number.isFinite(c.amount) &&
      results.some((r) => numbersIn(r).has(roundValue(Math.abs(c.amount))));
    const next = markUnsourced({ ...c, cites }, cites);
    if (!sure && (next.basis === undefined || next.basis.trim() === "")) {
      next.basis = ESTIMATE_BASIS;
    }
    return { ...next, estimate: !sure };
  });

  const dates = uniq(report.dates).map((d): ForkDateItem => {
    const { cites, results } = checkCites(d.cites);
    const day = d.date.slice(0, 10);
    const sure = !d.estimate && results.some((r) => datesIn(r).has(day));
    return { ...markUnsourced({ ...d, cites }, cites), estimate: !sure };
  });

  const people = uniq(report.people).map((p): ForkPerson => {
    const { cites } = checkCites(p.cites);
    const next = markUnsourced({ ...p, cites }, cites);
    if (next.personId !== undefined && !ctx.resolvePerson(next.personId)) {
      dropped.personIds += 1;
      delete next.personId;
    }
    return next;
  });

  const tradeoffs = uniq(report.tradeoffs).map((t): ForkTradeoff => {
    const { cites } = checkCites(t.cites);
    return markUnsourced({ ...t, cites }, cites);
  });
  const risks = uniq(report.risks).map((r): ForkRisk => {
    const { cites } = checkCites(r.cites);
    return markUnsourced({ ...r, cites }, cites);
  });
  const openQuestions = uniq(report.openQuestions);

  return {
    report: {
      summary: report.summary,
      steps,
      costs,
      dates,
      people,
      tradeoffs,
      risks,
      openQuestions,
    },
    readOwnerOnly,
    dropped,
  };
}
