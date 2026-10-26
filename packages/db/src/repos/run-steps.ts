import type { RunFrame, RunStep } from "@psyche/protocol";
import { and, asc, eq, gt, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { decodeJson } from "../mappers.ts";
import type { PsycheDb } from "../open.ts";
import { runFrames, runSteps, toolPayloads } from "../schema.ts";

/**
 * The run trace's store (docs/design/run-trace-2026.md §4.2–§4.3). Steps are written by the
 * Gateway's one sink, already redacted; `text.full` (retained thinking) is kept in its own
 * column so expiry blanks it without rewriting the step, and lists never carry it.
 */

function stepFromRow(row: typeof runSteps.$inferSelect, withText: boolean): RunStep {
  const step = decodeJson<RunStep>(row.data);
  if (step.text === undefined) return step;
  const text = { ...step.text };
  if (withText && row.textFull !== null) text.full = row.textFull;
  else delete text.full;
  if (row.textExpiresAt !== null) text.expiresAt = row.textExpiresAt;
  return { ...step, text };
}

/**
 * Inserts or replaces a step (by `(runId, id)`). The retained thinking text is written only
 * when the step carries it, so an update without it keeps what is stored.
 */
export function upsertRunStep(db: PsycheDb, step: RunStep): void {
  const { text, ...rest } = step;
  const full = text?.full;
  const data: RunStep =
    text === undefined
      ? rest
      : {
          ...rest,
          text: {
            summary: text.summary,
            ...(text.expiresAt === undefined ? {} : { expiresAt: text.expiresAt }),
          },
        };
  const at = db.now();
  db.drizzle
    .insert(runSteps)
    .values({
      runId: step.runId,
      id: step.id,
      seq: step.seq,
      kind: step.kind,
      status: step.status,
      toolCallId: step.toolCallId ?? null,
      data: JSON.stringify(data),
      textFull: full ?? null,
      textExpiresAt: full === undefined ? null : (text?.expiresAt ?? null),
      startedAt: step.startedAt,
      endedAt: step.endedAt ?? null,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [runSteps.runId, runSteps.id],
      set: {
        status: step.status,
        toolCallId: step.toolCallId ?? null,
        data: JSON.stringify(data),
        ...(full === undefined ? {} : { textFull: full, textExpiresAt: text?.expiresAt ?? null }),
        endedAt: step.endedAt ?? null,
        updatedAt: at,
      },
    })
    .run();
}

/** A run's steps in seq order after `afterSeq`, without retained thinking text. */
export function listRunSteps(
  db: PsycheDb,
  runId: string,
  options: { afterSeq?: number; limit?: number } = {},
): RunStep[] {
  return db.drizzle
    .select()
    .from(runSteps)
    .where(and(eq(runSteps.runId, runId), gt(runSteps.seq, options.afterSeq ?? 0)))
    .orderBy(asc(runSteps.seq))
    .limit(options.limit ?? 500)
    .all()
    .map((r) => stepFromRow(r, false));
}

/** One step, with its retained thinking text when it has not expired. */
export function getRunStep(db: PsycheDb, runId: string, stepId: string): RunStep | undefined {
  const row = db.drizzle
    .select()
    .from(runSteps)
    .where(and(eq(runSteps.runId, runId), eq(runSteps.id, stepId)))
    .get();
  return row === undefined ? undefined : stepFromRow(row, true);
}

export function countRunSteps(db: PsycheDb, runId: string): number {
  const row = db.drizzle
    .select({ n: sql<number>`count(*)` })
    .from(runSteps)
    .where(eq(runSteps.runId, runId))
    .get();
  return row?.n ?? 0;
}

/** The highest seq of a run (0 before its first step). */
export function lastRunStepSeq(db: PsycheDb, runId: string): number {
  const row = db.drizzle
    .select({ n: sql<number | null>`max(${runSteps.seq})` })
    .from(runSteps)
    .where(eq(runSteps.runId, runId))
    .get();
  return row?.n ?? 0;
}

/** Retention (§4.3): blanks thinking text whose `expiresAt` passed. Returns how many. */
export function expireRunStepText(db: PsycheDb, now: string): number {
  return db.drizzle
    .update(runSteps)
    .set({ textFull: null })
    .where(
      and(
        isNotNull(runSteps.textFull),
        isNotNull(runSteps.textExpiresAt),
        lt(runSteps.textExpiresAt, now),
      ),
    )
    .run().changes;
}

// --- Frames ----------------------------------------------------------------------------------

export interface NewRunFrame {
  readonly runId: string;
  readonly at: string;
  readonly stepId: string | null;
  readonly width: number;
  readonly height: number;
  /** Where the JPEG is, relative to the run's recording folder. */
  readonly path: string;
}

/** Appends a frame and returns its seq (per run, from 1). */
export function addRunFrame(db: PsycheDb, input: NewRunFrame): number {
  return db.sqlite.transaction(() => {
    const row = db.drizzle
      .select({ n: sql<number | null>`max(${runFrames.seq})` })
      .from(runFrames)
      .where(eq(runFrames.runId, input.runId))
      .get();
    const seq = (row?.n ?? 0) + 1;
    db.drizzle
      .insert(runFrames)
      .values({
        runId: input.runId,
        seq,
        at: input.at,
        stepId: input.stepId,
        width: input.width,
        height: input.height,
        path: input.path,
      })
      .run();
    return seq;
  })();
}

export interface StoredRunFrame extends RunFrame {
  readonly path: string | null;
}

export function listRunFrames(
  db: PsycheDb,
  runId: string,
  options: { stepId?: string; afterSeq?: number; limit?: number } = {},
): StoredRunFrame[] {
  return db.drizzle
    .select()
    .from(runFrames)
    .where(
      and(
        eq(runFrames.runId, runId),
        gt(runFrames.seq, options.afterSeq ?? 0),
        options.stepId === undefined ? undefined : eq(runFrames.stepId, options.stepId),
      ),
    )
    .orderBy(asc(runFrames.seq))
    .limit(options.limit ?? 600)
    .all()
    .map((r) => ({
      seq: r.seq,
      at: r.at,
      stepId: r.stepId,
      width: r.width,
      height: r.height,
      path: r.path,
      ...(r.expiredAt === null ? {} : { expired: true }),
    }));
}

/** Retention (§4.3): frames older than `cutoff` lose their file; returns them to delete. */
export function expireRunFramesBefore(
  db: PsycheDb,
  cutoff: string,
  now: string,
): { runId: string; seq: number; path: string }[] {
  return db.sqlite.transaction(() => {
    const due = db.drizzle
      .select({ runId: runFrames.runId, seq: runFrames.seq, path: runFrames.path })
      .from(runFrames)
      .where(and(isNull(runFrames.expiredAt), lt(runFrames.at, cutoff)))
      .all();
    db.drizzle
      .update(runFrames)
      .set({ expiredAt: now, path: null })
      .where(and(isNull(runFrames.expiredAt), lt(runFrames.at, cutoff)))
      .run();
    return due.flatMap((d) => (d.path === null ? [] : [{ ...d, path: d.path }]));
  })();
}

// --- Payloads --------------------------------------------------------------------------------

/** A step's stored tool input and output (`runs.step`), decoded as JSON or text. */
export function stepPayloads(
  db: PsycheDb,
  stepId: string,
): { input?: unknown; output?: unknown; truncated: boolean } {
  const rows = db.drizzle.select().from(toolPayloads).where(eq(toolPayloads.stepId, stepId)).all();
  const out: { input?: unknown; output?: unknown; truncated: boolean } = { truncated: false };
  for (const r of rows) {
    const text = Buffer.from(r.data).toString("utf8");
    const value = r.mime === "application/json" ? safeJson(text) : text;
    if (r.kind === "params") out.input = value;
    else if (r.kind === "result") out.output = value;
    if (r.truncated === 1) out.truncated = true;
  }
  return out;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * "Delete trace" (§4.3): a run's steps, payloads and frames go; the run row, its tool calls,
 * receipts and audit stay. Returns the frame files to remove.
 */
export function deleteRunTrace(db: PsycheDb, runId: string): string[] {
  return db.sqlite.transaction(() => {
    const files = db.drizzle
      .select({ path: runFrames.path })
      .from(runFrames)
      .where(eq(runFrames.runId, runId))
      .all()
      .flatMap((r) => (r.path === null ? [] : [r.path]));
    db.sqlite
      .prepare(
        "DELETE FROM tool_payloads WHERE step_id IN (SELECT id FROM run_steps WHERE run_id = ?)",
      )
      .run(runId);
    db.drizzle.delete(runSteps).where(eq(runSteps.runId, runId)).run();
    db.drizzle.delete(runFrames).where(eq(runFrames.runId, runId)).run();
    db.sqlite
      .prepare(
        "UPDATE runs SET step_count = 0, current_step_id = NULL, last_step_at = NULL WHERE id = ?",
      )
      .run(runId);
    return files;
  })();
}
