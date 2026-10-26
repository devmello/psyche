import type { Run, RunBudget, RunKind, RunOrigin, RunStatus, Usage } from "@psyche/protocol";
import { EMPTY_USAGE, PsycheError } from "@psyche/protocol";
import { and, desc, eq, gte, inArray, lt, notInArray, or, type SQL } from "drizzle-orm";
import { runFromRow } from "../mappers.ts";
import type { PsycheDb } from "../open.ts";
import { runs } from "../schema.ts";

export interface NewRun {
  readonly id?: string;
  readonly threadId: string;
  readonly modelRef: string;
  readonly attempt?: number;
  readonly status?: RunStatus;
  readonly startedAt?: string;
  // Run trace (§4.2).
  readonly kind?: RunKind;
  readonly title?: string;
  readonly parentRunId?: string | null;
  readonly rootRunId?: string | null;
  readonly taskId?: string | null;
  readonly automationRunId?: string | null;
  readonly origin?: RunOrigin;
  readonly budget?: RunBudget;
  readonly deadline?: string | null;
  readonly specialist?: { role: string };
}

export function createRun(db: PsycheDb, input: NewRun): Run {
  const at = db.now();
  const row = db.drizzle
    .insert(runs)
    .values({
      id: input.id ?? db.newId(),
      threadId: input.threadId,
      status: input.status ?? "running",
      modelRef: input.modelRef,
      attempt: input.attempt ?? 1,
      startedAt: input.startedAt ?? at,
      usage: JSON.stringify(EMPTY_USAGE),
      createdAt: at,
      updatedAt: at,
      kind: input.kind ?? null,
      title: input.title ?? null,
      parentRunId: input.parentRunId ?? null,
      rootRunId: input.rootRunId ?? null,
      taskId: input.taskId ?? null,
      automationRunId: input.automationRunId ?? null,
      origin: input.origin ?? null,
      budget: input.budget === undefined ? null : JSON.stringify(input.budget),
      deadline: input.deadline ?? null,
      specialist: input.specialist === undefined ? null : JSON.stringify(input.specialist),
    })
    .returning()
    .get();
  return runFromRow(row);
}

export function getRun(db: PsycheDb, id: string): Run | undefined {
  const row = db.drizzle.select().from(runs).where(eq(runs.id, id)).get();
  return row === undefined ? undefined : runFromRow(row);
}

export type TerminalRunStatus = Extract<RunStatus, "done" | "failed" | "cancelled">;

export interface FinishRun {
  readonly status: TerminalRunStatus;
  readonly error?: string | null;
  readonly usage?: Usage;
  readonly endedAt?: string;
}

/**
 * Marks a run finished. Does not release the transcript writer; callers pair it with
 * `releaseWriter` so a finished run cannot keep appending.
 */
export function finishRun(db: PsycheDb, id: string, input: FinishRun): Run {
  const at = db.now();
  const row = db.drizzle
    .update(runs)
    .set({
      status: input.status,
      endedAt: input.endedAt ?? at,
      error: input.error ?? null,
      ...(input.usage === undefined ? {} : { usage: JSON.stringify(input.usage) }),
      updatedAt: at,
    })
    .where(eq(runs.id, id))
    .returning()
    .get();
  if (row === undefined) throw new PsycheError("not_found", `run ${id} not found`);
  return runFromRow(row);
}

/**
 * Sets a non-terminal status (`running`, `awaiting_approval`, `awaiting_input`) or usage. A run
 * that already finished (`done`, `failed`, `cancelled`) is returned unchanged: a late event from
 * a superseded run cannot reopen it.
 */
export function updateRun(
  db: PsycheDb,
  id: string,
  patch: { status?: RunStatus; usage?: Usage; error?: string | null; endedAt?: string | null },
): Run {
  const set: Partial<typeof runs.$inferInsert> = { updatedAt: db.now() };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.usage !== undefined) set.usage = JSON.stringify(patch.usage);
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.endedAt !== undefined) set.endedAt = patch.endedAt;
  const row = db.drizzle
    .update(runs)
    .set(set)
    .where(and(eq(runs.id, id), notInArray(runs.status, ["done", "failed", "cancelled"])))
    .returning()
    .get();
  if (row !== undefined) return runFromRow(row);
  const existing = getRun(db, id);
  if (existing === undefined) throw new PsycheError("not_found", `run ${id} not found`);
  return existing;
}

export function listRunsByStatus(db: PsycheDb, statuses: readonly RunStatus[]): Run[] {
  if (statuses.length === 0) return [];
  return db.drizzle
    .select()
    .from(runs)
    .where(inArray(runs.status, [...statuses]))
    .all()
    .map(runFromRow);
}

/** The trace's view of a run: what changes as steps arrive (run trace §4.2). */
export interface RunTracePatch {
  readonly kind?: RunKind;
  readonly title?: string;
  readonly origin?: RunOrigin;
  readonly taskId?: string | null;
  readonly automationRunId?: string | null;
  readonly stepCount?: number;
  readonly currentStepId?: string | null;
  readonly lastStepAt?: string | null;
  readonly note?: string | null;
  readonly budget?: RunBudget;
}

/** Updates a run's trace fields; it never touches status, so a finished run can still gain them. */
export function patchRunTrace(db: PsycheDb, id: string, patch: RunTracePatch): Run | undefined {
  const set: Partial<typeof runs.$inferInsert> = { updatedAt: db.now() };
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.origin !== undefined) set.origin = patch.origin;
  if (patch.taskId !== undefined) set.taskId = patch.taskId;
  if (patch.automationRunId !== undefined) set.automationRunId = patch.automationRunId;
  if (patch.stepCount !== undefined) set.stepCount = patch.stepCount;
  if (patch.currentStepId !== undefined) set.currentStepId = patch.currentStepId;
  if (patch.lastStepAt !== undefined) set.lastStepAt = patch.lastStepAt;
  if (patch.note !== undefined) set.note = patch.note;
  if (patch.budget !== undefined) set.budget = JSON.stringify(patch.budget);
  const row = db.drizzle.update(runs).set(set).where(eq(runs.id, id)).returning().get();
  return row === undefined ? undefined : runFromRow(row);
}

export interface RunListFilter {
  readonly status?: readonly RunStatus[];
  readonly kind?: RunKind;
  readonly threadId?: string;
  readonly taskId?: string;
  readonly parentRunId?: string;
  readonly rootRunId?: string;
  /** Runs whose `automation_run_id` is one of these (the caller joins the automation). */
  readonly automationRunIds?: readonly string[];
  readonly since?: string;
  /** Keyset cursor: runs strictly older than this `(startedAt, id)`. */
  readonly before?: { startedAt: string; id: string };
  readonly limit: number;
}

/** Runs newest first (`runs.list`). */
export function listRuns(db: PsycheDb, f: RunListFilter): Run[] {
  const where: SQL[] = [];
  if (f.status !== undefined && f.status.length > 0)
    where.push(inArray(runs.status, [...f.status]));
  if (f.kind !== undefined) where.push(eq(runs.kind, f.kind));
  if (f.threadId !== undefined) where.push(eq(runs.threadId, f.threadId));
  if (f.taskId !== undefined) where.push(eq(runs.taskId, f.taskId));
  if (f.parentRunId !== undefined) where.push(eq(runs.parentRunId, f.parentRunId));
  if (f.rootRunId !== undefined) where.push(eq(runs.rootRunId, f.rootRunId));
  if (f.automationRunIds !== undefined) {
    if (f.automationRunIds.length === 0) return [];
    where.push(inArray(runs.automationRunId, [...f.automationRunIds]));
  }
  if (f.since !== undefined) where.push(gte(runs.startedAt, f.since));
  if (f.before !== undefined) {
    const older = or(
      lt(runs.startedAt, f.before.startedAt),
      and(eq(runs.startedAt, f.before.startedAt), lt(runs.id, f.before.id)),
    );
    if (older !== undefined) where.push(older);
  }
  return db.drizzle
    .select()
    .from(runs)
    .where(where.length === 0 ? undefined : and(...where))
    .orderBy(desc(runs.startedAt), desc(runs.id))
    .limit(f.limit)
    .all()
    .map(runFromRow);
}
