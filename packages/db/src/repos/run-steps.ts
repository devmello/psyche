import { gunzipSync, gzipSync } from "node:zlib";
import type { RunFrame, RunStep } from "@psyche/protocol";
import { and, asc, eq, gt, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { decodeJson } from "../mappers.ts";
import type { PsycheDb } from "../open.ts";
import { runFrames, runSteps, stepPayloadRows, toolPayloads } from "../schema.ts";

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
  // A model call's own payloads (gzip), written by `putStepPayload`.
  for (const r of db.drizzle
    .select()
    .from(stepPayloadRows)
    .where(eq(stepPayloadRows.stepId, stepId))
    .all()) {
    const text = gunzipSync(Buffer.from(r.data)).toString("utf8");
    const value = r.truncated === 1 ? text : safeJson(text);
    if (r.kind === "input") out.input = value;
    else out.output = value;
    if (r.truncated === 1) out.truncated = true;
  }
  for (const r of rows) {
    const text = Buffer.from(r.data).toString("utf8");
    const value = r.mime === "application/json" ? safeJson(text) : text;
    if (r.kind === "params") out.input = value;
    else if (r.kind === "result") out.output = value;
    if (r.truncated === 1) out.truncated = true;
  }
  return out;
}

/**
 * Stores a model step's input or output, gzip-compressed (prompts repeat the whole thread, so
 * they compress well). A truncated body is plain text (head and tail with a marker); an intact
 * one is JSON. Replaces the step's earlier payload of that kind.
 */
export function putStepPayload(
  db: PsycheDb,
  input: {
    readonly runId: string;
    readonly stepId: string;
    readonly kind: "input" | "output";
    readonly text: string;
    readonly truncated: boolean;
  },
): string {
  const id = db.newId();
  db.sqlite
    .prepare("DELETE FROM step_payloads WHERE step_id = ? AND kind = ?")
    .run(input.stepId, input.kind);
  db.drizzle
    .insert(stepPayloadRows)
    .values({
      id,
      runId: input.runId,
      stepId: input.stepId,
      kind: input.kind,
      data: gzipSync(Buffer.from(input.text, "utf8")),
      truncated: input.truncated ? 1 : 0,
      createdAt: db.now(),
    })
    .run();
  return id;
}

/** What a forgotten phrase becomes in stored run-trace payloads. */
export const FORGOTTEN_MARKER = "[forgotten]";

/** Rows read per batch by `scrubTracePayloads`; the event loop runs between batches. */
const SCRUB_BATCH_ROWS = 50;

/**
 * Cuts a forgotten phrase out of every stored run-trace text: model-call input and output
 * (`step_payloads`, gzip), the step's tool payloads, and each step's preview (`run_steps.data`)
 * and retained thinking text (`run_steps.text_full`). Intact JSON is scrubbed string by string,
 * so JSON escaping never hides a match; truncated payloads and thinking text are plain text. A
 * row is rewritten only when it changed.
 *
 * SQL cannot search gzip, so each table is read in keyset batches by rowid. Every batch is one
 * short synchronous read, and each write is its own statement (no long transaction). The loop
 * yields to the event loop between batches, so the Gateway keeps serving while it runs. Returns
 * how many rows were rewritten.
 */
export async function scrubTracePayloads(
  db: PsycheDb,
  pattern: RegExp,
  batchRows: number = SCRUB_BATCH_ROWS,
): Promise<number> {
  const find = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  let changed = 0;

  const sweep = async (
    select: string,
    handle: (row: Record<string, unknown>) => boolean,
  ): Promise<void> => {
    const stmt = db.sqlite.prepare(`${select} WHERE rowid > ? ORDER BY rowid LIMIT ?`);
    let after = 0;
    for (;;) {
      const rows = stmt.all(after, batchRows) as { rid: number }[];
      for (const row of rows) {
        if (handle(row as Record<string, unknown>)) changed += 1;
      }
      const last = rows.at(-1);
      if (last === undefined || rows.length < batchRows) return;
      after = last.rid;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  const writeStep = db.sqlite.prepare("UPDATE step_payloads SET data = ? WHERE rowid = ?");
  await sweep("SELECT rowid AS rid, data, truncated FROM step_payloads", (row) => {
    const text = gunzipSync(Buffer.from(row.data as Buffer)).toString("utf8");
    const next = scrubBody(text, row.truncated !== 1, find);
    if (next === undefined) return false;
    writeStep.run(gzipSync(Buffer.from(next, "utf8")), row.rid);
    return true;
  });

  const writeTool = db.sqlite.prepare("UPDATE tool_payloads SET data = ? WHERE rowid = ?");
  await sweep("SELECT rowid AS rid, data, mime, truncated, step_id FROM tool_payloads", (row) => {
    // Only a step's own payloads: other tool payloads belong to no trace step.
    if (row.step_id === null) return false;
    const text = Buffer.from(row.data as Buffer).toString("utf8");
    const json = row.mime === "application/json" && row.truncated !== 1;
    const next = scrubBody(text, json, find);
    if (next === undefined) return false;
    writeTool.run(Buffer.from(next, "utf8"), row.rid);
    return true;
  });

  const writeRunStep = db.sqlite.prepare(
    "UPDATE run_steps SET data = ?, text_full = ? WHERE rowid = ?",
  );
  await sweep("SELECT rowid AS rid, data, text_full FROM run_steps", (row) => {
    const data = row.data as string;
    const full = row.text_full as string | null;
    const nextData = scrubBody(data, true, find);
    const nextFull = full === null ? undefined : scrubBody(full, false, find);
    if (nextData === undefined && nextFull === undefined) return false;
    writeRunStep.run(nextData ?? data, nextFull ?? full, row.rid);
    return true;
  });

  return changed;
}

/** The scrubbed body, or `undefined` when the phrase does not occur in it. */
function scrubBody(text: string, json: boolean, find: RegExp): string | undefined {
  if (json) {
    let value: unknown;
    let parsed = true;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      parsed = false;
    }
    if (parsed) {
      const next = JSON.stringify(scrubJsonStrings(value, find));
      return next === text ? undefined : next;
    }
  }
  const next = text.replace(find, FORGOTTEN_MARKER);
  return next === text ? undefined : next;
}

/** Replaces the phrase in every string value (not in keys), leaving the structure as it is. */
function scrubJsonStrings(value: unknown, find: RegExp): unknown {
  if (typeof value === "string") return value.replace(find, FORGOTTEN_MARKER);
  if (Array.isArray(value)) return value.map((x) => scrubJsonStrings(x, find));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, x]) => [k, scrubJsonStrings(x, find)]),
    );
  }
  return value;
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
    db.sqlite.prepare("DELETE FROM step_payloads WHERE run_id = ?").run(runId);
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
