import { type Clock, EMPTY_USAGE, type ModelRef, type Usage } from "@psyche/protocol";
import { addUsage, roundUsd } from "./usage.ts";

/** One `usage` row (data model §10). */
export interface UsageRow {
  id: string;
  runId: string | null;
  job: string | null;
  modelRef: ModelRef;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  costUsd: number;
  /** ISO-8601 UTC. */
  createdAt: string;
}

export interface UsageAggregate {
  modelRef: ModelRef;
  calls: number;
  usage: Usage;
}

/** Storage for usage rows. `aggregate` covers `[from, to)` by `createdAt`. */
export interface UsageRepository {
  insert(row: UsageRow): void | Promise<void>;
  aggregate(from: string, to: string): UsageAggregate[] | Promise<UsageAggregate[]>;
}

export class InMemoryUsageRepository implements UsageRepository {
  readonly rows: UsageRow[] = [];

  insert(row: UsageRow): void {
    this.rows.push({ ...row });
  }

  aggregate(from: string, to: string): UsageAggregate[] {
    const by = new Map<string, UsageAggregate>();
    for (const r of this.rows) {
      if (r.createdAt < from || r.createdAt >= to) continue;
      const a = by.get(r.modelRef) ?? { modelRef: r.modelRef, calls: 0, usage: { ...EMPTY_USAGE } };
      a.calls += 1;
      a.usage = addUsage(a.usage, r);
      by.set(r.modelRef, a);
    }
    return [...by.values()].sort((a, b) => (a.modelRef < b.modelRef ? -1 : 1));
  }
}

/** The subset of a better-sqlite3 connection the repository uses. */
export interface SqliteLike {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/** Rows in the `usage` table created by `packages/db` (`202610182200_db_init.sql`). */
export class SqliteUsageRepository implements UsageRepository {
  readonly #db: SqliteLike;

  constructor(db: SqliteLike) {
    this.#db = db;
  }

  insert(row: UsageRow): void {
    this.#db
      .prepare(
        `INSERT INTO usage (id, run_id, job, model_ref, input, output, cache_read, cache_write, reasoning, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.runId,
        row.job,
        row.modelRef,
        row.input,
        row.output,
        row.cacheRead,
        row.cacheWrite,
        row.reasoning,
        row.costUsd,
        row.createdAt,
      );
  }

  aggregate(from: string, to: string): UsageAggregate[] {
    const rows = this.#db
      .prepare(
        `SELECT model_ref AS modelRef, COUNT(*) AS calls, SUM(input) AS input, SUM(output) AS output,
                SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite,
                SUM(reasoning) AS reasoning, SUM(cost_usd) AS costUsd
         FROM usage WHERE created_at >= ? AND created_at < ?
         GROUP BY model_ref ORDER BY model_ref`,
      )
      .all(from, to) as (Usage & { modelRef: string; calls: number })[];
    return rows.map((r) => ({
      modelRef: r.modelRef,
      calls: r.calls,
      usage: {
        input: r.input,
        output: r.output,
        cacheRead: r.cacheRead,
        cacheWrite: r.cacheWrite,
        reasoning: r.reasoning,
        costUsd: roundUsd(r.costUsd),
      },
    }));
  }
}

export interface BudgetAlert {
  /** `YYYY-MM` (UTC). */
  month: string;
  /** Fraction crossed: 0.8 or 1. */
  threshold: number;
  spentUsd: number;
  budgetUsd: number;
}

export interface UsageSummary {
  from: string;
  to: string;
  totals: Usage;
  calls: number;
  byModel: UsageAggregate[];
  budgetUsd: number | undefined;
  /** Percent of the monthly budget used / remaining (0–100), when a budget is set. */
  usedPercent: number | undefined;
  remainingPercent: number | undefined;
  /** Models with no price entry: their cost is counted as 0. */
  unpricedModels: ModelRef[];
}

export interface UsageLedgerOptions {
  repo: UsageRepository;
  clock: Clock;
  newId: () => string;
  /** Monthly budget in USD; alerts fire when spend crosses each threshold. */
  budgetUsd?: number;
  thresholds?: number[];
  onBudgetAlert?: (alert: BudgetAlert) => void;
}

export interface RecordInput {
  modelRef: ModelRef;
  usage: Usage;
  runId?: string;
  job?: string;
  unpriced?: boolean;
}

/** `[start, end)` of the UTC month containing `ms`. */
export function monthRange(ms: number): { from: string; to: string; month: string } {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return {
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    month: new Date(start).toISOString().slice(0, 7),
  };
}

/**
 * Usage ledger (B3): one row per model call, a summary for the usage meter, and a monthly
 * budget alert that fires once per threshold per month (thresholds already crossed when the
 * ledger starts are not re-announced; call `init()` after construction).
 */
export class UsageLedger {
  readonly #o: UsageLedgerOptions;
  readonly #fired = new Set<string>();
  readonly #unpriced = new Set<ModelRef>();
  #budgetUsd: number | undefined;

  constructor(options: UsageLedgerOptions) {
    this.#o = options;
    this.#budgetUsd = options.budgetUsd;
  }

  get budgetUsd(): number | undefined {
    return this.#budgetUsd;
  }

  /** Change the budget (settings); thresholds already crossed this month stay quiet. */
  async setBudget(budgetUsd: number | undefined): Promise<void> {
    this.#budgetUsd = budgetUsd;
    this.#fired.clear();
    await this.init();
  }

  /** Mark thresholds already crossed this month as announced. */
  async init(): Promise<void> {
    await this.#check(false);
  }

  async record(input: RecordInput): Promise<UsageRow> {
    const row: UsageRow = {
      id: this.#o.newId(),
      runId: input.runId ?? null,
      job: input.job ?? null,
      modelRef: input.modelRef,
      input: input.usage.input,
      output: input.usage.output,
      cacheRead: input.usage.cacheRead,
      cacheWrite: input.usage.cacheWrite,
      reasoning: input.usage.reasoning,
      costUsd: input.usage.costUsd,
      createdAt: new Date(this.#o.clock.now()).toISOString(),
    };
    if (input.unpriced === true) this.#unpriced.add(input.modelRef);
    await this.#o.repo.insert(row);
    await this.#check(true);
    return row;
  }

  async #check(announce: boolean): Promise<void> {
    const budget = this.#budgetUsd;
    if (budget === undefined || budget <= 0) return;
    const { from, to, month } = monthRange(this.#o.clock.now());
    const rows = await this.#o.repo.aggregate(from, to);
    const spent = rows.reduce((s, r) => s + r.usage.costUsd, 0);
    for (const t of [...(this.#o.thresholds ?? [0.8, 1])].sort((a, b) => a - b)) {
      const key = `${month}:${t}`;
      if (spent < budget * t || this.#fired.has(key)) continue;
      this.#fired.add(key);
      if (announce) {
        this.#o.onBudgetAlert?.({
          month,
          threshold: t,
          spentUsd: roundUsd(spent),
          budgetUsd: budget,
        });
      }
    }
  }

  /** `usage.summary` for the meter: the current UTC month unless a range is given. */
  async summary(range?: { from: string; to: string }): Promise<UsageSummary> {
    const r = range ?? monthRange(this.#o.clock.now());
    const byModel = await this.#o.repo.aggregate(r.from, r.to);
    let totals: Usage = { ...EMPTY_USAGE };
    let calls = 0;
    for (const m of byModel) {
      totals = addUsage(totals, m.usage);
      calls += m.calls;
    }
    const budget = this.#budgetUsd;
    const used =
      budget === undefined || budget <= 0
        ? undefined
        : Math.min(100, (totals.costUsd / budget) * 100);
    return {
      from: r.from,
      to: r.to,
      totals,
      calls,
      byModel,
      budgetUsd: budget,
      usedPercent: used === undefined ? undefined : Math.round(used * 10) / 10,
      remainingPercent: used === undefined ? undefined : Math.round((100 - used) * 10) / 10,
      unpricedModels: byModel.map((m) => m.modelRef).filter((ref) => this.#unpriced.has(ref)),
    };
  }
}
