import type { Run, RunStatus, Usage } from "@psyche/protocol";
import { EMPTY_USAGE, PsycheError } from "@psyche/protocol";
import { eq, inArray } from "drizzle-orm";
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

/** Sets a non-terminal status (`running`, `awaiting_approval`, `awaiting_input`) or usage. */
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
  const row = db.drizzle.update(runs).set(set).where(eq(runs.id, id)).returning().get();
  if (row === undefined) throw new PsycheError("not_found", `run ${id} not found`);
  return runFromRow(row);
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
