import { getSetting, type PsycheDb } from "@psyche/db";
import { isSubscriptionKind, type ProviderConfig } from "@psyche/model-router";
import {
  type MethodParams,
  type MethodResult,
  type ModelRef,
  PsycheError,
  type Usage,
  type UsageByModel,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";

/**
 * `usage.summary` (redesign #599): tokens, cost and turns from the run ledger for the sidebar's
 * usage footer. Read-only and additive: runs already carry their usage and model; the days are
 * counted in the owner's time zone; the monthly budget is the `usage.monthlyBudgetUsd` setting.
 * No adapter reports a subscription's rate-limit window yet, so `planWindow` is always null.
 */

export const BUDGET_KEY = "usage.monthlyBudgetUsd";

export interface UsageSummarySetup {
  db: PsycheDb;
  providers: readonly ProviderConfig[];
  /** The primary role's model (the router's, or the fixed provider's). */
  primary: () => ModelRef | undefined;
  now?: () => Date;
}

interface Tally {
  tokens: number;
  costUsd: number;
  turns: number;
}

const DAY_MS = 86_400_000;
const zero = (): Tally => ({ tokens: 0, costUsd: 0, turns: 0 });
const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

function add(t: Tally, tokens: number, costUsd: number): void {
  t.tokens += tokens;
  t.costUsd += costUsd;
  t.turns += 1;
}

/** `YYYY-MM-DD` of `date` in `timeZone`. */
function dayIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function parseUsage(raw: string): Usage | null {
  try {
    const u = JSON.parse(raw) as Partial<Usage>;
    return {
      input: Number(u.input ?? 0),
      output: Number(u.output ?? 0),
      cacheRead: Number(u.cacheRead ?? 0),
      cacheWrite: Number(u.cacheWrite ?? 0),
      reasoning: Number(u.reasoning ?? 0),
      costUsd: Number(u.costUsd ?? 0),
    };
  } catch {
    return null;
  }
}

export function usageSummaryHandlers(setup: UsageSummarySetup): Record<string, HandlerDef> {
  const kinds = new Map(setup.providers.map((p) => [p.id, p.kind]));
  const subscription = (ref: string) => {
    const kind = kinds.get(ref.split("/")[0] ?? "");
    return kind !== undefined && isSubscriptionKind(kind);
  };
  const byModelList = (m: Map<string, Tally>): UsageByModel[] =>
    [...m.entries()]
      .map(([modelRef, t]) => ({
        modelRef,
        subscription: subscription(modelRef),
        tokens: t.tokens,
        costUsd: round(t.costUsd),
        turns: t.turns,
      }))
      .sort((a, b) => b.tokens - a.tokens || a.modelRef.localeCompare(b.modelRef));

  return {
    "usage.summary": {
      run(_call: Call, params: MethodParams<"usage.summary">): MethodResult<"usage.summary"> {
        const timeZone = params.timeZone ?? "UTC";
        try {
          new Intl.DateTimeFormat("en-CA", { timeZone });
        } catch {
          throw new PsycheError("invalid_params", `unknown time zone ${timeZone}`);
        }
        const days = params.days ?? 7;
        const now = setup.now?.() ?? new Date();
        const today = dayIn(now, timeZone);
        const month = today.slice(0, 7);
        // The window's day keys, oldest first (a DST day can repeat; keep each once).
        const keys = [
          ...new Set(
            Array.from({ length: days }, (_, i) =>
              dayIn(new Date(now.getTime() - (days - 1 - i) * DAY_MS), timeZone),
            ),
          ),
        ];
        const perDay = new Map(keys.map((k) => [k, zero()]));
        const windowByModel = new Map<string, Tally>();
        const todayByModel = new Map<string, Tally>();
        const todayTally = zero();
        const monthTally = zero();
        // Enough history for the window and the month so far, with a day of slack for zones.
        const since = new Date(now.getTime() - (Math.max(days, 31) + 1) * DAY_MS).toISOString();
        const rows = setup.db.sqlite
          .prepare(
            "SELECT model_ref AS modelRef, started_at AS startedAt, usage FROM runs WHERE started_at >= ?",
          )
          .all(since) as { modelRef: string; startedAt: string; usage: string }[];
        for (const row of rows) {
          const u = parseUsage(row.usage);
          if (u === null) continue;
          const tokens = u.input + u.output + u.reasoning;
          const day = dayIn(new Date(row.startedAt), timeZone);
          const slot = perDay.get(day);
          if (slot !== undefined) {
            add(slot, tokens, u.costUsd);
            const m = windowByModel.get(row.modelRef) ?? zero();
            add(m, tokens, u.costUsd);
            windowByModel.set(row.modelRef, m);
          }
          if (day === today) {
            add(todayTally, tokens, u.costUsd);
            const m = todayByModel.get(row.modelRef) ?? zero();
            add(m, tokens, u.costUsd);
            todayByModel.set(row.modelRef, m);
          }
          if (day.startsWith(month)) add(monthTally, tokens, u.costUsd);
        }
        const budget = Number(getSetting(setup.db, BUDGET_KEY)?.value);
        return {
          days: keys.map((date) => {
            const t = perDay.get(date) ?? zero();
            return { date, tokens: t.tokens, costUsd: round(t.costUsd), turns: t.turns };
          }),
          today: {
            tokens: todayTally.tokens,
            costUsd: round(todayTally.costUsd),
            turns: todayTally.turns,
            byModel: byModelList(todayByModel),
          },
          byModel: byModelList(windowByModel),
          month: {
            tokens: monthTally.tokens,
            costUsd: round(monthTally.costUsd),
            turns: monthTally.turns,
          },
          budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : null,
          primary: setup.primary() ?? null,
          planWindow: null,
        };
      },
    },
  };
}
