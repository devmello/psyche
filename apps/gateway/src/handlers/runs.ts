import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  deleteRunTrace,
  getRun,
  getRunStep,
  insertLibraryItem,
  listRunFrames,
  listRunSteps,
  listRuns,
  listToolCallsForRun,
  type PsycheDb,
  stepPayloads,
} from "@psyche/db";
import {
  buildPsycheTrace,
  type MethodParams,
  type MethodResult,
  PsycheError,
  type Run,
  type RunStep,
  type RunSummary,
  type TraceRunInput,
  traceMarkdown,
} from "@psyche/protocol";
import { zipSync } from "fflate";
import type { Call, HandlerDef } from "../context.ts";
import { removeFrameFile, runRecordingsDir } from "../retention.ts";

/**
 * `runs.*` (docs/design/run-trace-2026.md §4.4): the run trace's reads, its export and "Delete
 * trace". Everything here was redacted when the sink wrote it; exports are redacted again.
 */

const STEPS_PAGE = 500;
/** Exports larger than this go to the Library instead of inline (§4.4). */
export const EXPORT_INLINE_BYTES = 8 * 1024 * 1024;
const ACTIVITY_BUCKETS = 12;
const ACTIVITY_BUCKET_MS = 5000;

function requireRun(db: PsycheDb, runId: string): Run {
  const run = getRun(db, runId);
  if (run === undefined) throw new PsycheError("not_found", `run ${runId} not found`);
  return run;
}

/** `runs.list` cursor: the last row's `(startedAt, id)`, opaque to clients. */
function encodeCursor(run: Run): string {
  return Buffer.from(JSON.stringify([run.startedAt, run.id])).toString("base64url");
}

function decodeCursor(cursor: string): { startedAt: string; id: string } {
  try {
    const [startedAt, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [
      string,
      string,
    ];
    if (typeof startedAt === "string" && typeof id === "string") return { startedAt, id };
  } catch {
    // fall through
  }
  throw new PsycheError("invalid_params", "invalid cursor");
}

function automationOf(db: PsycheDb, automationRunId: string | null | undefined): string | null {
  if (automationRunId == null) return null;
  const row = db.sqlite
    .prepare("SELECT automation_id FROM automation_runs WHERE id = ?")
    .get(automationRunId) as { automation_id: string } | undefined;
  return row?.automation_id ?? null;
}

/** A list row: the run with its current step, a sparkline while it runs, and usual durations. */
function summarize(call: Call, run: Run): RunSummary {
  const { db } = call.ctx;
  const out: RunSummary = { ...run };
  if (run.currentStepId != null) {
    const step = getRunStep(db, run.id, run.currentStepId);
    if (step !== undefined) {
      out.currentStep = { label: step.label, status: step.status, startedAt: step.startedAt };
    }
  }
  if (run.status === "running") {
    const now = call.ctx.now().getTime();
    const since = new Date(now - ACTIVITY_BUCKETS * ACTIVITY_BUCKET_MS).toISOString();
    const rows = db.sqlite
      .prepare("SELECT started_at FROM run_steps WHERE run_id = ? AND started_at >= ?")
      .all(run.id, since) as { started_at: string }[];
    const buckets = Array.from({ length: ACTIVITY_BUCKETS }, () => 0);
    for (const r of rows) {
      const age = now - Date.parse(r.started_at);
      const i = ACTIVITY_BUCKETS - 1 - Math.floor(age / ACTIVITY_BUCKET_MS);
      if (i >= 0 && i < ACTIVITY_BUCKETS) buckets[i] = (buckets[i] ?? 0) + 1;
    }
    out.activity = buckets;
  }
  const automationId = automationOf(db, run.automationRunId);
  if (automationId !== null) {
    const rows = db.sqlite
      .prepare(
        `SELECT r.started_at, r.ended_at FROM runs r JOIN automation_runs a ON a.id = r.automation_run_id
         WHERE a.automation_id = ? AND r.ended_at IS NOT NULL ORDER BY r.started_at DESC LIMIT 10`,
      )
      .all(automationId) as { started_at: string; ended_at: string }[];
    out.durationsMs = rows.map((r) =>
      Math.max(0, Date.parse(r.ended_at) - Date.parse(r.started_at)),
    );
  }
  return out;
}

/** Everything a run's export needs: steps with kept thinking, tool names and payloads. */
function traceInput(db: PsycheDb, run: Run): TraceRunInput {
  const steps: RunStep[] = [];
  for (let afterSeq = 0; ; ) {
    const page = listRunSteps(db, run.id, { afterSeq, limit: STEPS_PAGE });
    steps.push(...page);
    if (page.length < STEPS_PAGE) break;
    afterSeq = page.at(-1)?.seq ?? afterSeq;
  }
  const tools: Record<string, string> = {};
  for (const tc of listToolCallsForRun(db, run.id)) {
    if (tc.stepId !== undefined) tools[tc.stepId] = tc.tool;
  }
  const payloads: Record<string, { input?: unknown; output?: unknown }> = {};
  const thinking: Record<string, string> = {};
  for (const s of steps) {
    if (s.payloadRef !== undefined) {
      const { truncated: _t, ...p } = stepPayloads(db, s.id);
      payloads[s.id] = p;
    }
    if (s.kind === "thinking") {
      const full = getRunStep(db, run.id, s.id)?.text?.full;
      if (full !== undefined) thinking[s.id] = full;
    }
  }
  return { run, steps, tools, payloads, thinking };
}

function isIncognito(call: Call, run: Run): boolean {
  const row = call.ctx.db.sqlite
    .prepare("SELECT kind FROM threads WHERE id = ?")
    .get(run.threadId) as { kind: string } | undefined;
  return row?.kind === "incognito";
}

function exportRun(call: Call, params: MethodParams<"runs.export">): MethodResult<"runs.export"> {
  const { db } = call.ctx;
  const run = requireRun(db, params.runId);
  const sink = call.ctx.runTrace;
  const children = listRuns(db, { parentRunId: run.id, limit: 100 });
  const frames =
    params.includeFrames === true &&
    params.format === "psyche-trace+json" &&
    !isIncognito(call, run)
      ? listRunFrames(db, run.id).filter((f) => f.path !== null)
      : [];
  const trace = sink.redactDeep(
    buildPsycheTrace({
      ...traceInput(db, run),
      exportedAt: call.ctx.now().toISOString(),
      children: children.map((c) => traceInput(db, c)),
      frames,
    }),
  );
  const base = `psyche-trace-${run.id}`;
  let fileName: string;
  let mime: string;
  let bytes: Uint8Array;
  if (params.format === "markdown") {
    fileName = `${base}.md`;
    mime = "text/markdown";
    bytes = new TextEncoder().encode(traceMarkdown(trace));
  } else if (frames.length === 0) {
    fileName = `${base}.json`;
    mime = "application/vnd.psyche-trace+json";
    bytes = new TextEncoder().encode(JSON.stringify(trace, null, 2));
  } else {
    // §4.7: with frames, a .zip of trace.json and frames/.
    const dir = runRecordingsDir(call.ctx.config.home, run.id);
    const files: Record<string, Uint8Array> = {
      "trace.json": new TextEncoder().encode(JSON.stringify(trace, null, 2)),
    };
    for (const f of frames) {
      try {
        files[`frames/${f.seq}.jpg`] = readFileSync(join(dir, f.path as string));
      } catch {
        // A frame removed since it was listed: the trace still names it.
      }
    }
    fileName = `${base}.zip`;
    mime = "application/zip";
    bytes = zipSync(files, { level: 0 });
  }
  if (bytes.byteLength <= EXPORT_INLINE_BYTES) {
    return { fileName, mime, dataBase64: Buffer.from(bytes).toString("base64") };
  }
  // Too large to inline: saved to the Library, which the client opens.
  const rel = join("exports", fileName);
  const abs = join(call.ctx.config.home, "library", rel);
  mkdirSync(join(call.ctx.config.home, "library", "exports"), { recursive: true, mode: 0o700 });
  writeFileSync(abs, bytes, { mode: 0o600 });
  const item = insertLibraryItem(db, {
    kind: "document",
    name: fileName,
    mime,
    path: rel,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    origin: "agent",
    threadId: run.threadId,
    taskId: run.taskId ?? null,
  });
  return { fileName, mime, libraryItemId: item.id };
}

export const runsHandlers: Record<string, HandlerDef> = {
  "runs.get": {
    run(call: Call, params: MethodParams<"runs.get">): MethodResult<"runs.get"> {
      const { db } = call.ctx;
      const run = requireRun(db, params.runId);
      return {
        run,
        steps: listRunSteps(db, run.id, { limit: STEPS_PAGE }),
        children: listRuns(db, { parentRunId: run.id, limit: 100 }).reverse(),
      };
    },
  },
  "runs.steps": {
    run(call: Call, params: MethodParams<"runs.steps">): MethodResult<"runs.steps"> {
      const { db } = call.ctx;
      requireRun(db, params.runId);
      const limit = params.limit ?? STEPS_PAGE;
      const steps = listRunSteps(db, params.runId, {
        ...(params.afterSeq === undefined ? {} : { afterSeq: params.afterSeq }),
        limit,
      });
      return { steps, nextSeq: steps.length === limit ? (steps.at(-1)?.seq ?? null) : null };
    },
  },
  "runs.list": {
    run(call: Call, params: MethodParams<"runs.list">): MethodResult<"runs.list"> {
      const { db } = call.ctx;
      const limit = params.limit ?? 50;
      let automationRunIds: string[] | undefined;
      if (params.automationId !== undefined) {
        automationRunIds = (
          db.sqlite
            .prepare("SELECT id FROM automation_runs WHERE automation_id = ?")
            .all(params.automationId) as { id: string }[]
        ).map((r) => r.id);
      }
      const runs = listRuns(db, {
        ...(params.status === undefined ? {} : { status: params.status }),
        ...(params.kind === undefined ? {} : { kind: params.kind }),
        ...(params.threadId === undefined ? {} : { threadId: params.threadId }),
        ...(params.taskId === undefined ? {} : { taskId: params.taskId }),
        ...(params.parentRunId === undefined ? {} : { parentRunId: params.parentRunId }),
        ...(params.rootRunId === undefined ? {} : { rootRunId: params.rootRunId }),
        ...(automationRunIds === undefined ? {} : { automationRunIds }),
        ...(params.since === undefined ? {} : { since: params.since }),
        ...(params.cursor === undefined ? {} : { before: decodeCursor(params.cursor) }),
        limit: limit + 1,
      });
      const page = runs.slice(0, limit);
      const last = page.at(-1);
      return {
        runs: page.map((r) => summarize(call, r)),
        nextCursor: runs.length > limit && last !== undefined ? encodeCursor(last) : null,
      };
    },
  },
  "runs.children": {
    run(call: Call, params: MethodParams<"runs.children">): MethodResult<"runs.children"> {
      const { db } = call.ctx;
      requireRun(db, params.runId);
      return {
        runs: listRuns(db, { parentRunId: params.runId, limit: 100 })
          .reverse()
          .map((r) => summarize(call, r)),
      };
    },
  },
  "runs.step": {
    run(call: Call, params: MethodParams<"runs.step">): MethodResult<"runs.step"> {
      const { db } = call.ctx;
      const step = getRunStep(db, params.runId, params.stepId);
      if (step === undefined) throw new PsycheError("not_found", `step ${params.stepId} not found`);
      const { truncated, ...payloads } =
        step.payloadRef === undefined ? { truncated: false } : stepPayloads(db, step.id);
      return { step, ...payloads, truncated };
    },
  },
  "runs.frames": {
    run(call: Call, params: MethodParams<"runs.frames">): MethodResult<"runs.frames"> {
      const { db } = call.ctx;
      requireRun(db, params.runId);
      return {
        frames: listRunFrames(db, params.runId, {
          ...(params.stepId === undefined ? {} : { stepId: params.stepId }),
          ...(params.afterSeq === undefined ? {} : { afterSeq: params.afterSeq }),
          ...(params.limit === undefined ? {} : { limit: params.limit }),
        }).map(({ path: _path, ...f }) => f),
      };
    },
  },
  "runs.frame": {
    run(call: Call, params: MethodParams<"runs.frame">): MethodResult<"runs.frame"> {
      const { db } = call.ctx;
      const frame = listRunFrames(db, params.runId, { afterSeq: params.seq - 1, limit: 1 })[0];
      if (frame === undefined || frame.seq !== params.seq) {
        throw new PsycheError("not_found", `frame ${params.seq} not found`);
      }
      if (frame.path === null) {
        throw new PsycheError("not_found", "that frame expired", {
          details: { reason: "expired" },
        });
      }
      // Frames are stored at 1280 px; the client scales the thumbnail.
      const data = readFileSync(
        join(runRecordingsDir(call.ctx.config.home, params.runId), frame.path),
      );
      return { mime: "image/jpeg", dataBase64: data.toString("base64") };
    },
  },
  "runs.export": {
    run: (call: Call, params: MethodParams<"runs.export">) => exportRun(call, params),
  },
  "runs.delete": {
    run(call: Call, params: MethodParams<"runs.delete">): MethodResult<"runs.delete"> {
      const { db, bus } = call.ctx;
      const run = requireRun(db, params.runId);
      const files = db.sqlite.transaction(() => {
        const removed = deleteRunTrace(db, run.id);
        bus.bumpStateVersion();
        return removed;
      })();
      for (const path of files) {
        try {
          removeFrameFile(call.ctx.config.home, run.id, path);
        } catch {
          // The row is gone; a leftover file is swept with its folder.
        }
      }
      const updated = getRun(db, run.id);
      if (updated !== undefined) bus.publish("run.updated", { run: updated }, run.threadId);
      return { ok: true };
    },
  },
};
