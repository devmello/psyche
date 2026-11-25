import {
  FORK_BUDGET_USD_MAX,
  FORK_BUDGET_USD_MIN,
  FORK_SETTING_DEFAULTS,
  type ForkReport,
  type PlanComparison,
  type PlanFork,
  type PlanForkBranch,
  type PlanForkBranchStatus,
  type PlanForkStatus,
  type TaintSource,
} from "@psyche/protocol";
import { asc, desc, eq, inArray } from "drizzle-orm";
import type { PsycheDb } from "../open.ts";
import {
  type PlanForkBranchRow,
  type PlanForkRow,
  planForkBranches,
  planForks,
  stagedActions,
} from "../schema.ts";

/**
 * Fork a plan storage (docs/design/fork-a-plan-2026.md §7.1). Rows in, rows out: the service owns
 * the rules (states, budget split, report checks, scrubbing); nothing here runs a tool.
 *
 * `staged_actions.fork_branch_id` has no FK (Night shift W0 decided that). Deleting a branch
 * therefore deletes its staged items here, and the `plan_fork_branches_staged_delete` trigger does
 * the same for every other way a branch row can go (the cascade from its fork or its thread).
 */

const json = (v: unknown): string | null =>
  v === undefined || v === null ? null : JSON.stringify(v);
const parse = <T>(v: string | null): T | null => (v === null ? null : (JSON.parse(v) as T));

export function planForkFromRow(row: PlanForkRow): PlanFork {
  return {
    id: row.id as string,
    threadId: row.threadId,
    forkMessageId: row.forkMessageId,
    status: row.status as PlanForkStatus,
    error: row.error,
    budgetUsd: row.budgetUsd,
    spentUsd: row.spentUsd,
    tokens: row.tokens,
    comparison: parse<PlanComparison>(row.comparison),
    takenBranchId: row.takenBranchId,
    takeApprovalId: row.takeApprovalId,
    createdByDeviceId: row.createdByDeviceId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
  };
}

export function planForkBranchFromRow(row: PlanForkBranchRow): PlanForkBranch {
  return {
    id: row.id as string,
    forkId: row.forkId,
    ord: row.ord,
    label: row.label,
    premise: row.premise,
    threadId: row.threadId,
    taskId: row.taskId,
    status: row.status as PlanForkBranchStatus,
    error: row.error,
    report: parse<ForkReport>(row.report),
    readOwnerOnly: row.readOwnerOnly === 1,
    taint: row.taint === 1,
    taintSources: JSON.parse(row.taintSources) as TaintSource[],
    spentUsd: row.spentUsd,
    tokens: row.tokens,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface NewPlanFork {
  id?: string;
  threadId: string;
  forkMessageId?: string | null;
  status?: PlanForkStatus;
  /** Defaults to `FORK_SETTING_DEFAULTS["forks.budgetUsd"]` ($1.00); range $0.10 to $5.00. */
  budgetUsd?: number;
  createdByDeviceId?: string | null;
  expiresAt?: string | null;
}

export function insertPlanFork(db: PsycheDb, input: NewPlanFork): PlanFork {
  const budgetUsd = input.budgetUsd ?? FORK_SETTING_DEFAULTS["forks.budgetUsd"];
  if (!(budgetUsd >= FORK_BUDGET_USD_MIN && budgetUsd <= FORK_BUDGET_USD_MAX)) {
    throw new RangeError(
      `fork budget must be between ${FORK_BUDGET_USD_MIN} and ${FORK_BUDGET_USD_MAX} dollars`,
    );
  }
  const now = db.now();
  const row = db.drizzle
    .insert(planForks)
    .values({
      id: input.id ?? db.newId(),
      threadId: input.threadId,
      forkMessageId: input.forkMessageId ?? null,
      status: input.status ?? "running",
      budgetUsd,
      createdByDeviceId: input.createdByDeviceId ?? null,
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return planForkFromRow(row);
}

export function getPlanFork(db: PsycheDb, id: string): PlanFork | null {
  const row = db.drizzle.select().from(planForks).where(eq(planForks.id, id)).get();
  return row === undefined ? null : planForkFromRow(row);
}

/** The forks of a thread, newest first. */
export function listPlanForks(db: PsycheDb, threadId: string): PlanFork[] {
  return db.drizzle
    .select()
    .from(planForks)
    .where(eq(planForks.threadId, threadId))
    .orderBy(desc(planForks.createdAt), desc(planForks.id))
    .all()
    .map(planForkFromRow);
}

/** The fork of a thread that is `running` or `comparing`, if any (at most one, by index). */
export function getLivePlanForkForThread(db: PsycheDb, threadId: string): PlanFork | null {
  const row = db.drizzle
    .select()
    .from(planForks)
    .where(eq(planForks.threadId, threadId))
    .all()
    .find((r) => r.status === "running" || r.status === "comparing");
  return row === undefined ? null : planForkFromRow(row);
}

export function listPlanForksByStatus(db: PsycheDb, statuses: PlanForkStatus[]): PlanFork[] {
  if (statuses.length === 0) return [];
  return db.drizzle
    .select()
    .from(planForks)
    .where(inArray(planForks.status, statuses))
    .orderBy(asc(planForks.createdAt), asc(planForks.id))
    .all()
    .map(planForkFromRow);
}

export interface PlanForkPatch {
  status?: PlanForkStatus;
  error?: string | null;
  spentUsd?: number;
  tokens?: number;
  comparison?: PlanComparison | null;
  takenBranchId?: string | null;
  takeApprovalId?: string | null;
  expiresAt?: string | null;
  finishedAt?: string | null;
}

export function updatePlanFork(db: PsycheDb, id: string, patch: PlanForkPatch): PlanFork | null {
  const set: Partial<typeof planForks.$inferInsert> = { updatedAt: db.now() };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.spentUsd !== undefined) set.spentUsd = patch.spentUsd;
  if (patch.tokens !== undefined) set.tokens = patch.tokens;
  if (patch.comparison !== undefined) set.comparison = json(patch.comparison);
  if (patch.takenBranchId !== undefined) set.takenBranchId = patch.takenBranchId;
  if (patch.takeApprovalId !== undefined) set.takeApprovalId = patch.takeApprovalId;
  if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt;
  if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt;
  const row = db.drizzle.update(planForks).set(set).where(eq(planForks.id, id)).returning().get();
  return row === undefined ? null : planForkFromRow(row);
}

/** Deletes a fork, its branches and every branch's staged items. Returns whether it existed. */
export function deletePlanFork(db: PsycheDb, id: string): boolean {
  return db.sqlite.transaction(() => {
    const branchIds = db.drizzle
      .select({ id: planForkBranches.id })
      .from(planForkBranches)
      .where(eq(planForkBranches.forkId, id))
      .all()
      .map((b) => b.id as string);
    if (branchIds.length > 0) {
      db.drizzle.delete(stagedActions).where(inArray(stagedActions.forkBranchId, branchIds)).run();
    }
    return db.drizzle.delete(planForks).where(eq(planForks.id, id)).run().changes > 0;
  })();
}

export interface NewPlanForkBranch {
  id?: string;
  forkId: string;
  ord: number;
  label: string;
  premise: string;
  threadId: string;
  taskId?: string | null;
  status?: PlanForkBranchStatus;
}

export function insertPlanForkBranch(db: PsycheDb, input: NewPlanForkBranch): PlanForkBranch {
  const now = db.now();
  const row = db.drizzle
    .insert(planForkBranches)
    .values({
      id: input.id ?? db.newId(),
      forkId: input.forkId,
      ord: input.ord,
      label: input.label,
      premise: input.premise,
      threadId: input.threadId,
      taskId: input.taskId ?? null,
      status: input.status ?? "queued",
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return planForkBranchFromRow(row);
}

export function getPlanForkBranch(db: PsycheDb, id: string): PlanForkBranch | null {
  const row = db.drizzle.select().from(planForkBranches).where(eq(planForkBranches.id, id)).get();
  return row === undefined ? null : planForkBranchFromRow(row);
}

/** The branch whose hidden thread this is, if any (used to keep branch threads out of lists). */
export function getPlanForkBranchByThread(db: PsycheDb, threadId: string): PlanForkBranch | null {
  const row = db.drizzle
    .select()
    .from(planForkBranches)
    .where(eq(planForkBranches.threadId, threadId))
    .get();
  return row === undefined ? null : planForkBranchFromRow(row);
}

export function listPlanForkBranches(db: PsycheDb, forkId: string): PlanForkBranch[] {
  return db.drizzle
    .select()
    .from(planForkBranches)
    .where(eq(planForkBranches.forkId, forkId))
    .orderBy(asc(planForkBranches.ord))
    .all()
    .map(planForkBranchFromRow);
}

export interface PlanForkBranchPatch {
  taskId?: string | null;
  status?: PlanForkBranchStatus;
  error?: string | null;
  report?: ForkReport | null;
  readOwnerOnly?: boolean;
  taint?: boolean;
  taintSources?: readonly TaintSource[];
  spentUsd?: number;
  tokens?: number;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export function updatePlanForkBranch(
  db: PsycheDb,
  id: string,
  patch: PlanForkBranchPatch,
): PlanForkBranch | null {
  const set: Partial<typeof planForkBranches.$inferInsert> = { updatedAt: db.now() };
  if (patch.taskId !== undefined) set.taskId = patch.taskId;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.report !== undefined) set.report = json(patch.report);
  if (patch.readOwnerOnly !== undefined) set.readOwnerOnly = patch.readOwnerOnly ? 1 : 0;
  if (patch.taint !== undefined) set.taint = patch.taint ? 1 : 0;
  if (patch.taintSources !== undefined) set.taintSources = JSON.stringify(patch.taintSources);
  if (patch.spentUsd !== undefined) set.spentUsd = patch.spentUsd;
  if (patch.tokens !== undefined) set.tokens = patch.tokens;
  if (patch.startedAt !== undefined) set.startedAt = patch.startedAt;
  if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt;
  const row = db.drizzle
    .update(planForkBranches)
    .set(set)
    .where(eq(planForkBranches.id, id))
    .returning()
    .get();
  return row === undefined ? null : planForkBranchFromRow(row);
}

/** Deletes a branch and its staged items (no FK on `staged_actions`). Returns whether it existed. */
export function deletePlanForkBranch(db: PsycheDb, id: string): boolean {
  return db.sqlite.transaction(() => {
    db.drizzle.delete(stagedActions).where(eq(stagedActions.forkBranchId, id)).run();
    return db.drizzle.delete(planForkBranches).where(eq(planForkBranches.id, id)).run().changes > 0;
  })();
}

/**
 * Files a branch's one report (fork-a-plan-2026 §2.3, §4.1). One statement: the row is written
 * only while it is `running` and holds no report, so a second filing (a model retry after a host
 * that committed and then threw, a run replayed after a restart) changes nothing. Returns whether
 * this call wrote it. `read_owner_only` only ever goes up: a run that read Memory, Messages or
 * Contacts marked the row already, and a later run's report (after a retry or a restart) can't
 * clear it.
 */
export function fileBranchReport(
  db: PsycheDb,
  id: string,
  report: ForkReport,
  extra: { readOwnerOnly?: boolean } = {},
): boolean {
  const res = db.sqlite
    .prepare(
      `UPDATE plan_fork_branches
          SET report = ?, read_owner_only = MAX(read_owner_only, ?), updated_at = ?
        WHERE id = ? AND report IS NULL AND status = 'running'`,
    )
    .run(JSON.stringify(report), extra.readOwnerOnly === true ? 1 : 0, db.now(), id);
  return res.changes > 0;
}
