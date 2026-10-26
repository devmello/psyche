import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable } from "../common.ts";
import { RunFrame, RunStep, RunSummary, RunTraceFormat } from "../schemas/runs.ts";
import { Run, RunKind, RunStatus } from "../schemas/threads.ts";
import { Cursor, defineMethod } from "./define.ts";

/**
 * `runs.*`: the run trace's reads (docs/design/run-trace-2026.md §4.4). Every string the Gateway
 * returns was redacted when it was written; exports are redacted again. Old clients ignore these.
 */

const RunIdParams = Type.Object({ runId: Id }, { $id: "RunIdParams" });

export const RunGetResult = Type.Object(
  {
    run: Run,
    steps: Type.Array(RunStep, { description: "The first 500 steps; page with runs.steps" }),
    children: Type.Array(Run, { description: "Helper and specialist runs it spawned" }),
  },
  { $id: "RunGetResult" },
);
export type RunGetResult = Static<typeof RunGetResult>;

export const RunsMethods = {
  "runs.get": defineMethod({
    params: RunIdParams,
    result: RunGetResult,
    scope: "operator.read",
    description: "Returns one run with its first 500 steps and its helper runs.",
  }),
  "runs.steps": defineMethod({
    params: Type.Object({
      runId: Id,
      afterSeq: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }),
    result: Type.Object({
      steps: Type.Array(RunStep),
      nextSeq: Nullable(Type.Integer({ minimum: 0 })),
    }),
    scope: "operator.read",
    description:
      "Pages a run's steps in seq order after afterSeq (a client that missed events catches up with it).",
  }),
  "runs.list": defineMethod({
    params: Type.Object({
      status: Type.Optional(Type.Array(RunStatus)),
      kind: Type.Optional(RunKind),
      threadId: Type.Optional(Id),
      taskId: Type.Optional(Id),
      automationId: Type.Optional(Id),
      parentRunId: Type.Optional(Id),
      rootRunId: Type.Optional(Id),
      since: Type.Optional(IsoDateTime),
      cursor: Type.Optional(Cursor),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    result: Type.Object({ runs: Type.Array(RunSummary), nextCursor: Nullable(Cursor) }),
    scope: "operator.read",
    description: "Lists runs, newest first, with their current step and activity.",
  }),
  "runs.children": defineMethod({
    params: RunIdParams,
    result: Type.Object({ runs: Type.Array(RunSummary) }),
    scope: "operator.read",
    description: "Lists a run's helper and specialist runs with status, budget and deadline.",
  }),
  "runs.step": defineMethod({
    params: Type.Object({ runId: Id, stepId: Id }),
    result: Type.Object({
      step: RunStep,
      input: Type.Optional(Type.Unknown()),
      output: Type.Optional(Type.Unknown()),
      truncated: Type.Boolean({ description: "A payload was over 1 MB: head and tail kept" }),
    }),
    scope: "operator.read",
    description:
      "Returns one step with its kept thinking text and its tool input and output (redacted).",
  }),
  "runs.frames": defineMethod({
    params: Type.Object({
      runId: Id,
      stepId: Type.Optional(Id),
      afterSeq: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
    }),
    result: Type.Object({ frames: Type.Array(RunFrame) }),
    scope: "operator.read",
    description: "Lists the frames Psyche saw during a run (or one step).",
  }),
  "runs.frame": defineMethod({
    params: Type.Object({
      runId: Id,
      seq: Type.Integer({ minimum: 1 }),
      size: Type.Union([Type.Literal("thumb"), Type.Literal("full")]),
    }),
    result: Type.Object({ mime: Type.String(), dataBase64: Type.String() }),
    scope: "operator.read",
    description: "Returns one frame image (masked as it was captured).",
  }),
  "runs.export": defineMethod({
    params: Type.Object({
      runId: Id,
      format: RunTraceFormat,
      includeFrames: Type.Optional(
        Type.Boolean({
          description: "psyche-trace+json only: a .zip with frames/ (never incognito)",
        }),
      ),
    }),
    result: Type.Object({
      fileName: Type.String(),
      mime: Type.String(),
      /** Inline up to 8 MB; larger exports are saved to the Library instead. */
      dataBase64: Type.Optional(Type.String()),
      libraryItemId: Type.Optional(Id),
    }),
    scope: "operator.read",
    description:
      "Exports a run's trace as psyche-trace+json v1 (OTel GenAI attribute names) or Markdown, redacted again.",
  }),
  "runs.delete": defineMethod({
    params: RunIdParams,
    result: Type.Object({ ok: Type.Literal(true) }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Deletes a run's trace (steps, payloads, frames); receipts and audit are kept. Side-effecting.",
  }),
} as const;
