import type { MemoryStore, SideEffect } from "@psyche/protocol";
import { readState, stateFile } from "./builtins/automation.ts";

/**
 * Run evidence: one entry per tool call the run really made (reads included), kept by the loop
 * from the tool-call records themselves. Receipts only exist for side effects, so a fetch through
 * the browser left no trace for the verifier; this ledger is what it checks instead of the
 * model's report. Workflow runs also have their outputs persisted from it (not by the model).
 */

export type EvidenceKind = "fetch" | "state" | "notify" | "write" | "other";

export interface ToolEvidence {
  callId: string;
  tool: string;
  kind: EvidenceKind;
  ok: boolean;
  sideEffect: SideEffect;
  /** Origin, path or recipient the call touched. */
  target?: string;
  /** The call in plain words (the same line the Timeline shows). */
  summary: string;
  receiptId?: string;
  /** Ids the result carried (reminder ids, notification ids), for shared state. */
  refs?: Record<string, string | string[]>;
  /** Failure text, shortened. */
  error?: string;
}

/** Steps a run may be required to show evidence for. `state` is written by the framework. */
export type ExpectedStep = "fetch" | "notify";

const SEVERITY_WRITE = new Set<SideEffect>(["write", "destructive", "financial"]);

export function classifyTool(
  tool: string,
  sideEffect: SideEffect,
  provenance: "trusted" | "untrusted" | undefined,
): EvidenceKind {
  if (tool === "notify") return "notify";
  if (tool.startsWith("automation_state_")) return "state";
  if (SEVERITY_WRITE.has(sideEffect)) return "write";
  // Reading something from outside (a page, a connector) is a fetch, whatever the tool is called:
  // the result is untrusted, or the tool says it reaches the network or the browser.
  if (provenance === "untrusted" || /^(browser|web|fetch|http)/.test(tool)) return "fetch";
  return "other";
}

const REF_CAP = 20;

/** Ids in a tool result: `id`, `*Id`, `ids`, and `id`s of objects in arrays. Nothing else. */
export function extractRefs(output: unknown): Record<string, string | string[]> | undefined {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
  const refs: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
    if (typeof value === "string" && (key === "id" || /Id$/.test(key))) {
      refs[key] = value.slice(0, 200);
    } else if (Array.isArray(value)) {
      const ids = value
        .map((v) =>
          typeof v === "string" && /(^|_)ids?$/i.test(key)
            ? v
            : typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "string"
              ? (v as { id: string }).id
              : undefined,
        )
        .filter((v): v is string => v !== undefined)
        .slice(0, REF_CAP)
        .map((v) => v.slice(0, 200));
      if (ids.length > 0) refs[key] = ids;
    }
  }
  return Object.keys(refs).length === 0 ? undefined : refs;
}

// --- Workflow prompts ---------------------------------------------------------------------------

/** `[workflow:<groupId>]` at the start of the job part of a linked run's prompt (proactive/daily/workflows.ts). */
export function workflowGroupOf(text: string): string | undefined {
  return /^\s*\[workflow:([a-z0-9][a-z0-9-]{2,40})\]/m.exec(text)?.[1];
}

/** `[expects: fetch, notify]`: the steps the run must show evidence for. */
export function expectedSteps(text: string): ExpectedStep[] {
  const m = /^\[expects:\s*([a-z, ]+)\]\s*$/m.exec(text);
  if (m === null) return [];
  const out = new Set<ExpectedStep>();
  for (const word of (m[1] ?? "").split(",")) {
    const w = word.trim();
    if (w === "fetch" || w === "notify") out.add(w);
  }
  return [...out];
}

// --- Checking -----------------------------------------------------------------------------------

export interface MissingStep {
  step: ExpectedStep;
  /** Plain words: what lacked evidence and why. */
  why: string;
}

const STEP_NAME: Record<ExpectedStep, string> = {
  fetch: "Fetch the data (browser or web)",
  notify: "Notify the owner",
};

const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Which expected steps have no evidence, and why each one is missing. */
export function missingSteps(
  expected: readonly ExpectedStep[],
  evidence: readonly ToolEvidence[],
): MissingStep[] {
  const out: MissingStep[] = [];
  for (const step of expected) {
    const calls = evidence.filter((e) => e.kind === step);
    if (calls.some((e) => e.ok)) continue;
    const failed = calls.filter((e) => !e.ok);
    const last = failed.at(-1);
    out.push({
      step,
      why:
        last === undefined
          ? step === "fetch"
            ? `${STEP_NAME.fetch}: no browser or web tool call was recorded in this run, so nothing shows the data was read.`
            : `${STEP_NAME.notify}: no notification was sent from this run.`
          : `${STEP_NAME[step]}: ${failed.length} attempt${failed.length === 1 ? "" : "s"} failed${last.error === undefined ? "" : ` (last: ${short(last.error)})`}.`,
    });
  }
  return out;
}

/** The evidence list, one plain line per call. Shown under a run's verdict. */
export function evidenceLines(evidence: readonly ToolEvidence[], cap = 30): string[] {
  const lines = evidence
    .filter((e) => e.kind !== "other" || !e.ok)
    .slice(0, cap)
    .map(
      (e) =>
        `${e.ok ? "ok" : "failed"} · ${e.kind} · ${short(e.summary, 100)}${e.receiptId === undefined ? "" : ` · receipt ${e.receiptId}`}${e.ok || e.error === undefined ? "" : ` · ${short(e.error, 100)}`}`,
    );
  return lines.length === 0 ? ["no tool calls were recorded"] : lines;
}

/** The run's failure text: `not_verified: <reason>` then `Evidence:` lines (parsed by the Gateway). */
export function notVerifiedText(reason: string, evidence: readonly ToolEvidence[]): string {
  return `${reason}\nEvidence:\n${evidenceLines(evidence)
    .map((l) => `- ${l}`)
    .join("\n")}`;
}

// --- Shared state -------------------------------------------------------------------------------

const RUN_KEEP = 10;
const STATE_BUDGET = 7_500;

export interface RecordedRun {
  at: string;
  /** `ok`: the run finished; `unverified`: it ended without the evidence it was expected to have. */
  status: "ok" | "unverified";
  created: {
    tool: string;
    summary: string;
    refs?: Record<string, string | string[]>;
    receiptId?: string;
  }[];
  fetched: { tool: string; target?: string; ok: boolean }[];
  /** Actions that did not happen (waiting for an approval, blocked, failed), with the reason. */
  notDone: { tool: string; summary: string; why: string }[];
}

/**
 * Persist what this run did into the workflow's shared state, from the tool-call records. The
 * model is not involved, so the write cannot be forgotten, deferred behind an approval nobody
 * answers at night, or lost with a tool that was never loaded. Later runs read it with
 * `automation_state_get` (`data.runs[<runId>]`, `data.latest`, `data.created`).
 */
export async function recordWorkflowRun(
  store: MemoryStore,
  group: string,
  input: {
    runId: string;
    at: string;
    status: RecordedRun["status"];
    evidence: readonly ToolEvidence[];
    tainted: boolean;
  },
): Promise<void> {
  const { current } = await readState(store, group);
  const record: RecordedRun = {
    at: input.at,
    status: input.status,
    created: input.evidence
      .filter((e) => e.ok && (e.kind === "write" || e.kind === "notify"))
      .map((e) => ({
        tool: e.tool,
        summary: short(e.summary, 120),
        ...(e.refs === undefined ? {} : { refs: e.refs }),
        ...(e.receiptId === undefined ? {} : { receiptId: e.receiptId }),
      })),
    notDone: input.evidence
      .filter((e) => !e.ok && (e.kind === "write" || e.kind === "notify" || e.kind === "state"))
      .map((e) => ({
        tool: e.tool,
        summary: short(e.summary, 120),
        why: short(e.error ?? "failed", 160),
      })),
    fetched: input.evidence
      .filter((e) => e.kind === "fetch")
      .map((e) => ({
        tool: e.tool,
        ok: e.ok,
        ...(e.target === undefined ? {} : { target: e.target }),
      })),
  };
  const data = { ...current.data };
  const runs = { ...((data.runs as Record<string, RecordedRun> | undefined) ?? {}) };
  runs[input.runId] = record;
  const keys = Object.keys(runs).sort((a, b) =>
    (runs[a]?.at ?? "").localeCompare(runs[b]?.at ?? ""),
  );
  for (const k of keys.slice(0, Math.max(0, keys.length - RUN_KEEP))) delete runs[k];
  data.runs = runs;
  data.latest = { runId: input.runId, ...record };
  data.created = Object.values(runs)
    .flatMap((r) => r.created)
    .slice(-50);
  let next = JSON.stringify({ data, tainted: current.tainted || input.tainted });
  // Over budget: drop the oldest runs until it fits (the latest run always stays).
  const order = Object.keys(runs);
  while (next.length > STATE_BUDGET && order.length > 1) {
    delete runs[order.shift() as string];
    data.created = Object.values(runs)
      .flatMap((r) => r.created)
      .slice(-50);
    next = JSON.stringify({ data, tainted: current.tainted || input.tainted });
  }
  await store.writeFile(stateFile(group), next, {
    provenance: input.tainted ? "untrusted" : "agent",
    trace: { runId: input.runId, toolCallId: `workflow-state:${input.runId}` },
  });
}
