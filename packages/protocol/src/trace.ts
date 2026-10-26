import { EMPTY_USAGE } from "./common.ts";
import {
  type PsycheTrace,
  RUN_TRACE_FORMAT,
  RUN_TRACE_VERSION,
  type RunStep,
  type TraceRun,
  type TraceStep,
} from "./schemas/runs.ts";
import type { Run } from "./schemas/threads.ts";

/**
 * The `psyche-trace+json` v1 recipe (docs/design/run-trace-2026.md §4.7), shared by the Gateway's
 * `runs.export` and the MockGateway so both write the same document. Step attributes use the
 * OpenTelemetry GenAI semantic-convention names where one exists, so OTLP is a later mapping.
 * Inputs here are already redacted (the Gateway re-runs its redactor before calling this).
 */

export interface TraceRunInput {
  run: Run;
  steps: readonly RunStep[];
  /** Tool names by step id (from the step's `ToolCall`), for `gen_ai.tool.name`. */
  tools?: Readonly<Record<string, string>>;
  /** Payload bodies by step id (`runs.step`'s input and output). */
  payloads?: Readonly<Record<string, { input?: unknown; output?: unknown }>>;
  /** Retained thinking text by step id. */
  thinking?: Readonly<Record<string, string>>;
}

export interface TraceInput extends TraceRunInput {
  exportedAt: string;
  children?: readonly TraceRunInput[];
  frames?: readonly { seq: number; at: string; stepId?: string | null }[];
}

const OPERATION: Partial<Record<RunStep["kind"], string>> = {
  model: "chat",
  tool: "execute_tool",
  subagent: "invoke_agent",
};

/** OTel GenAI attributes for a step, plus `psyche.*` for what GenAI has no name for. */
export function traceAttributes(
  step: RunStep,
  run: Run,
  tool?: string,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {
    "psyche.step.kind": step.kind,
    "psyche.step.status": step.status,
    "psyche.step.attempt": step.attempt,
  };
  const op = OPERATION[step.kind];
  if (op !== undefined) out["gen_ai.operation.name"] = op;
  if (step.kind === "model") {
    out["gen_ai.request.model"] = step.modelRef ?? run.modelRef;
    const u = step.usage ?? EMPTY_USAGE;
    out["gen_ai.usage.input_tokens"] = u.input;
    out["gen_ai.usage.output_tokens"] = u.output;
    if (u.reasoning > 0) out["gen_ai.usage.reasoning_tokens"] = u.reasoning;
    if (u.cacheRead > 0) out["gen_ai.usage.cache_read_input_tokens"] = u.cacheRead;
  }
  if (step.kind === "tool" && tool !== undefined) out["gen_ai.tool.name"] = tool;
  if (step.toolCallId !== undefined) out["gen_ai.tool.call.id"] = step.toolCallId;
  if (step.error !== undefined) out["error.type"] = step.error.code;
  return out;
}

function traceRun(run: Run): TraceRun {
  return {
    id: run.id,
    ...(run.kind === undefined ? {} : { kind: run.kind }),
    ...(run.title === undefined ? {} : { title: run.title }),
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    usage: run.usage,
    model: run.modelRef,
    parentRunId: run.parentRunId ?? null,
  };
}

function traceSteps(input: TraceRunInput): TraceStep[] {
  return [...input.steps]
    .sort((a, b) => a.seq - b.seq)
    .map((s) => {
      const payload = input.payloads?.[s.id];
      const thinking = input.thinking?.[s.id];
      return {
        id: s.id,
        seq: s.seq,
        ...(s.parentStepId === undefined ? {} : { parentStepId: s.parentStepId }),
        ...(s.groupId === undefined ? {} : { groupId: s.groupId }),
        kind: s.kind,
        status: s.status,
        label: s.endedAt != null && s.doneLabel !== undefined ? s.doneLabel : s.label,
        ...(s.target === undefined ? {} : { target: s.target }),
        startedAt: s.startedAt,
        endedAt: s.endedAt ?? null,
        attempt: s.attempt,
        attributes: traceAttributes(s, input.run, input.tools?.[s.id]),
        ...(payload?.input === undefined ? {} : { input: payload.input }),
        ...(payload?.output === undefined ? {} : { output: payload.output }),
        ...(thinking === undefined ? {} : { thinking }),
        ...(s.error === undefined ? {} : { error: s.error }),
        ...(s.childRunId === undefined ? {} : { childRunId: s.childRunId }),
      };
    });
}

export function buildPsycheTrace(input: TraceInput): PsycheTrace {
  return {
    format: RUN_TRACE_FORMAT,
    version: RUN_TRACE_VERSION,
    exportedAt: input.exportedAt,
    redacted: true,
    run: traceRun(input.run),
    steps: traceSteps(input),
    children: (input.children ?? []).map((c) => ({ run: traceRun(c.run), steps: traceSteps(c) })),
    frames: (input.frames ?? []).map((f) => ({
      seq: f.seq,
      at: f.at,
      stepId: f.stepId ?? null,
      file: `frames/${f.seq}.jpg`,
    })),
  };
}

function durationOf(startedAt: string, endedAt: string | null | undefined): string {
  if (endedAt == null) return "running";
  const ms = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

const MARK: Record<RunStep["status"], string> = {
  ok: "✓",
  failed: "✗",
  running: "…",
  pending: "·",
  waiting: "⏸",
  cancelled: "–",
  skipped: "–",
};

/**
 * The Markdown export (§4.7): a header, one line per step with its duration, and the failure.
 * For pasting into an issue or a message; English, like the logs it is read next to.
 */
export function traceMarkdown(trace: PsycheTrace): string {
  const r = trace.run;
  const lines = [
    `# ${r.title ?? "Run"} (${r.status})`,
    "",
    `- Run: \`${r.id}\`${r.kind === undefined ? "" : ` (${r.kind})`}`,
    `- Model: ${r.model}`,
    `- Started: ${r.startedAt} · took ${durationOf(r.startedAt, r.endedAt)}`,
    `- Tokens: ${r.usage.input} in, ${r.usage.output} out · $${r.usage.costUsd.toFixed(4)}`,
    "",
    "## Steps",
    "",
  ];
  const line = (s: TraceStep, indent: string) =>
    `${indent}${s.seq}. ${MARK[s.status]} ${s.label}${s.target === undefined ? "" : ` — ${s.target}`} (${durationOf(s.startedAt, s.endedAt)})${s.attempt > 1 ? ` · attempt ${s.attempt}` : ""}`;
  for (const s of trace.steps) {
    lines.push(line(s, ""));
    const child = trace.children.find((c) => c.run.id === s.childRunId);
    for (const cs of child?.steps ?? []) lines.push(line(cs, "    "));
  }
  const failed = [...trace.steps].reverse().find((s) => s.status === "failed");
  if (failed !== undefined) {
    lines.push("", "## What went wrong", "", `Step ${failed.seq}, ${failed.label}:`);
    lines.push(failed.error === undefined ? "No error was recorded." : failed.error.message);
  }
  lines.push("", `_Exported ${trace.exportedAt}. Secrets are redacted._`, "");
  return lines.join("\n");
}
