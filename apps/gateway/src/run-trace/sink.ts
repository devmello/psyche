import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addRunFrame,
  createRun,
  finishRun,
  getRun,
  lastRunStepSeq,
  type PsycheDb,
  patchRunTrace,
  putStepPayload,
  putToolPayload,
  upsertRunStep,
} from "@psyche/db";
import {
  type AgentEvent,
  EMPTY_USAGE,
  type ModelMessage,
  RUN_STEP_LIMITS,
  type Run,
  type RunStep,
  type RunStepStatus,
  type ToolCall,
  type ToolCallStatus,
  type ToolResult,
  type ToolSpec,
  type Usage,
} from "@psyche/protocol";
import type { EventBus } from "../event-bus.ts";

/**
 * The run trace's one sink (docs/design/run-trace-2026.md §4.2): every run's agent events become
 * `run_steps` rows and `run.step` events. Chat turns, helpers and (through the same `apply`) task
 * and automation turns all come through here, so a step never says two things. Every label,
 * target, preview, payload and thinking text is redacted before it is stored or sent (§4.6).
 *
 * Ids: a thinking step's id is its `chat.reasoning` stepId; every other step gets a fresh
 * `stp_` id, carried on the tool call as `ToolCall.stepId`. Helper runs get their own `runs` row
 * with a fresh id and `parentRunId`; the loop's `…:sub:…` id stays internal.
 */

export interface RunTraceOptions {
  readonly db: PsycheDb;
  readonly bus: EventBus;
  readonly now: () => Date;
  /** The one redactor (vault secrets, credential-like URL parameters). */
  readonly redact?: (text: string) => string;
  /** `data.reasoningRetentionDays` (0 = keep only the summary line). */
  readonly reasoningRetentionDays?: () => number;
  /** Incognito threads are never written (§4.3); their steps are only streamed. */
  readonly isIncognito?: (threadId: string) => boolean;
  /** `data.replayRetentionDays` (0 = keep no frames). */
  readonly replayRetentionDays?: () => number;
  /** Where a run's frames are written: `$PSYCHE_HOME/library/recordings/<runId>/`. */
  readonly recordingsDir?: (runId: string) => string;
}

/** One frame Psyche saw (a computer-use screenshot, masked as the helper captured it). */
export interface TraceFrame {
  data: Uint8Array;
  mime: string;
  width: number;
  height: number;
}

/** Progress updates of one step are published at most this often (§4.5: 4/s). */
export const PROGRESS_INTERVAL_MS = 250;
/** `run.updated` for trace fields (step count, current step) at most once a second per run. */
const RUN_UPDATE_INTERVAL_MS = 1000;

const STEP_ID_PREFIX = "stp_";
/** Tools whose step is a `subagent` step: a helper or a background specialist (§4.2). */
const SPAWN_TOOLS: ReadonlySet<string> = new Set(["subagent.spawn", "specialist.spawn"]);

/** A specialist job's status as its spawn step's. */
const SPECIALIST_STATUS: Record<
  Extract<AgentEvent, { type: "subagent" }>["status"],
  RunStepStatus
> = {
  queued: "running",
  working: "running",
  needs_you: "waiting",
  done: "ok",
  partial: "ok",
  failed: "failed",
  cancelled: "cancelled",
};

interface OpenText {
  stepId: string;
  messageId: string;
}

interface TraceRun {
  runId: string;
  threadId: string;
  /** Null when incognito: steps stream but are never stored. */
  store: boolean;
  seq: number;
  steps: Map<string, RunStep>;
  /** Tool call id → step id. */
  byToolCall: Map<string, string>;
  /** Thinking text by step id (capped), until the step is done. */
  thinking: Map<string, string>;
  text?: OpenText;
  /** When the model call now in progress began (the end of the last step that waited on it). */
  modelSince: string;
  lastUsage: Usage;
  /** The newest model step: `modelCall` attaches the call's input and output to it. */
  lastModelStepId?: string;
  /** Running tool steps by id: a call that starts while another runs joins its group. */
  runningTools: Set<string>;
  /** Open waits (approval, question) closed by the run's next event. */
  waits: Set<string>;
  /** Helper runs: the spawn step on the parent run. */
  parentStepId?: string;
  progressAt: Map<string, number>;
  progressTimers: Map<string, NodeJS.Timeout>;
  runUpdateAt: number;
  runUpdateTimer?: NodeJS.Timeout;
  folded: boolean;
}

/** A tool call's status as a step's (a blocked call is skipped; an uncertain one failed). */
function stepStatus(s: ToolCallStatus): RunStepStatus {
  switch (s) {
    case "pending":
    case "running":
    case "ok":
    case "failed":
      return s;
    case "uncertain":
      return "failed";
    case "blocked":
      return "skipped";
  }
}

const ENDED: ReadonlySet<RunStepStatus> = new Set([
  "ok",
  "failed",
  "cancelled",
  "skipped",
  "denied",
]);

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function preview(value: unknown, redact: (t: string) => string): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (text === undefined || text === "" || text === "{}") return undefined;
  return clip(redact(text), RUN_STEP_LIMITS.previewBytes);
}

/** A model call's prompt grows with the thread: its payloads are kept to 128 KB each. */
const MODEL_PAYLOAD_BYTES = 128 * 1024;

/** What a failed tool said, from its output (a string, or an `error`/`message` field). */
function errorText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output !== null && typeof output === "object") {
    const o = output as Record<string, unknown>;
    for (const k of ["error", "message", "reason"]) {
      const v = o[k];
      if (typeof v === "string" && v !== "") return v;
    }
  }
  try {
    return JSON.stringify(output) ?? "";
  } catch {
    return "";
  }
}

/** A payload body under the 1 MB cap: the head and tail with a marker past it (§4.5). */
function capPayload(
  text: string,
  max: number = RUN_STEP_LIMITS.payloadBytes,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= max) return { text, truncated: false };
  const half = Math.floor(max / 2) - 64;
  return {
    text: `${text.slice(0, half)}\n[… ${text.length - 2 * half} characters removed …]\n${text.slice(-half)}`,
    truncated: true,
  };
}

function subUsage(a: Usage, b: Usage): Usage {
  const d = (x: number, y: number) => Math.max(0, x - y);
  return {
    input: d(a.input, b.input),
    output: d(a.output, b.output),
    cacheRead: d(a.cacheRead, b.cacheRead),
    cacheWrite: d(a.cacheWrite, b.cacheWrite),
    reasoning: d(a.reasoning, b.reasoning),
    costUsd: Math.max(0, a.costUsd - b.costUsd),
  };
}

export class RunTraceSink {
  readonly #o: RunTraceOptions;
  readonly #runs = new Map<string, TraceRun>();
  /** The loop's helper run id → its own run id. */
  readonly #helpers = new Map<string, string>();
  /** Step ids handed out before their tool call was seen (`memoryChanged`), by `runId|callId`. */
  readonly #reserved = new Map<
    string,
    { stepId: string; memoryPath?: string; frames?: { first: number; last: number } }
  >();

  constructor(options: RunTraceOptions) {
    this.#o = options;
  }

  #redact(text: string): string {
    return this.#o.redact === undefined ? text : this.#o.redact(text);
  }

  #iso(): string {
    return this.#o.now().toISOString();
  }

  /** Starts (or resumes) tracing a run; the first event of a run calls this implicitly. */
  begin(runId: string, threadId: string): void {
    if (this.#runs.has(runId)) return;
    const store = this.#o.isIncognito?.(threadId) !== true;
    const run = store ? getRun(this.#o.db, runId) : undefined;
    this.#runs.set(runId, {
      runId,
      threadId,
      store,
      seq: store ? lastRunStepSeq(this.#o.db, runId) : 0,
      steps: new Map(),
      byToolCall: new Map(),
      thinking: new Map(),
      modelSince: this.#iso(),
      lastUsage: run?.usage ?? EMPTY_USAGE,
      runningTools: new Set(),
      waits: new Set(),
      progressAt: new Map(),
      progressTimers: new Map(),
      runUpdateAt: 0,
      folded: false,
    });
  }

  /** Defence in depth for exports (§4.6): every string of a value through the redactor again. */
  redactDeep<T>(value: T): T {
    if (typeof value === "string") return this.#redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v)) as T;
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, this.redactDeep(v)]),
      ) as T;
    }
    return value;
  }

  /**
   * A tool call changed a memory file (`memory.file.changed`): its step names the path. Returns
   * the step id for the event.
   */
  memoryChanged(runId: string, toolCallId: string, path: string): string {
    const memoryPath = clip(path, 1024);
    const t = this.#runs.get(runId);
    const id = t?.byToolCall.get(toolCallId);
    const step = id === undefined ? undefined : t?.steps.get(id);
    if (t !== undefined && id !== undefined && step !== undefined) {
      this.#put(t, { ...step, memoryPath });
      return id;
    }
    // The write can run before the call's own event reaches the sink: reserve its step id.
    const key = `${runId}|${toolCallId}`;
    const reserved = this.#reserved.get(key) ?? { stepId: this.#newId() };
    this.#reserved.set(key, { ...reserved, memoryPath });
    return reserved.stepId;
  }

  /**
   * A frame Psyche saw during a tool call (§4.2 "Frames"): written under the run's recording
   * folder and listed in `run_frames`; the call's step gets the frame range. Nothing is kept
   * for incognito runs or with `data.replayRetentionDays` Off. Returns the frame's seq.
   */
  addFrame(runId: string, toolCallId: string, frame: TraceFrame): number | undefined {
    const dir = this.#o.recordingsDir?.(runId);
    if (dir === undefined || (this.#o.replayRetentionDays?.() ?? 7) <= 0) return undefined;
    const run = getRun(this.#o.db, runId);
    if (run === undefined || this.#o.isIncognito?.(run.threadId) === true) return undefined;
    const t = this.#runs.get(runId);
    const known = t?.byToolCall.get(toolCallId);
    const key = `${runId}|${toolCallId}`;
    let stepId = known;
    if (stepId === undefined) {
      const reserved = this.#reserved.get(key) ?? { stepId: this.#newId() };
      this.#reserved.set(key, reserved);
      stepId = reserved.stepId;
    }
    const ext = frame.mime === "image/png" ? "png" : "jpg";
    const rel = `frames/${this.#o.db.newId()}.${ext}`;
    mkdirSync(join(dir, "frames"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, rel), frame.data, { mode: 0o600 });
    const seq = addRunFrame(this.#o.db, {
      runId,
      at: this.#iso(),
      stepId,
      width: frame.width,
      height: frame.height,
      path: rel,
    });
    const step = known === undefined ? undefined : t?.steps.get(known);
    if (t !== undefined && step !== undefined) {
      this.#put(t, { ...step, frames: { first: step.frames?.first ?? seq, last: seq } });
    } else {
      const reserved = this.#reserved.get(key);
      if (reserved !== undefined) {
        reserved.frames = { first: reserved.frames?.first ?? seq, last: seq };
      }
    }
    return seq;
  }

  /** The step that shows a tool call, once the sink has seen it. */
  stepIdFor(runId: string, toolCallId: string): string | undefined {
    return this.#runs.get(runId)?.byToolCall.get(toolCallId);
  }

  /** Applies one agent event of `runId`. Returns the step it touched, if any. */
  apply(runId: string, threadId: string, event: AgentEvent): string | undefined {
    this.begin(runId, threadId);
    const t = this.#runs.get(runId) as TraceRun;
    const at = this.#iso();
    if (event.type !== "approval_requested" && event.type !== "question")
      this.#closeWaits(t, at, event);
    switch (event.type) {
      case "reasoning":
        return this.#reasoning(t, event, at);
      case "chat.delta": {
        if (t.text?.messageId === event.messageId) return t.text.stepId;
        this.#closeText(t, at);
        const id = this.#newId();
        t.text = { stepId: id, messageId: event.messageId };
        this.#put(t, {
          id,
          kind: "text",
          status: "running",
          label: "Writing a reply",
          doneLabel: "Wrote a reply",
          startedAt: at,
        });
        return id;
      }
      case "tool_call":
        return this.#tool(t, event, at);
      case "subagent":
        return this.#specialist(t, event, at);
      case "approval_requested": {
        this.#closeText(t, at);
        const id = this.#newId();
        t.waits.add(id);
        this.#put(t, {
          id,
          kind: "approval",
          status: "waiting",
          label: clip(
            this.#redact(`Waiting for your approval: ${event.approval.summary}`),
            RUN_STEP_LIMITS.labelChars,
          ),
          doneLabel: clip(
            this.#redact(`Approval answered: ${event.approval.summary}`),
            RUN_STEP_LIMITS.labelChars,
          ),
          startedAt: at,
          approvalId: event.approval.id,
          ...(event.approval.requestedBy.taskId == null
            ? {}
            : { taskId: event.approval.requestedBy.taskId }),
        });
        return id;
      }
      case "question": {
        this.#closeText(t, at);
        const id = this.#newId();
        t.waits.add(id);
        const first = event.inputRequest.questions[0]?.question ?? "a question";
        this.#put(t, {
          id,
          kind: "question",
          status: "waiting",
          label: clip(
            this.#redact(`Waiting for your answer: ${first}`),
            RUN_STEP_LIMITS.labelChars,
          ),
          doneLabel: clip(this.#redact(`You answered: ${first}`), RUN_STEP_LIMITS.labelChars),
          startedAt: at,
          inputRequestId: event.inputRequest.id,
        });
        return id;
      }
      case "usage":
        return this.#model(t, event.usage, at);
      case "block": {
        if (event.block.type !== "artifact") return undefined;
        const id = this.#newId();
        this.#put(t, {
          id,
          kind: "artifact",
          status: "ok",
          label: "Making a file",
          doneLabel: "Made a file",
          startedAt: at,
          endedAt: at,
          artifactId: event.block.artifactId,
        });
        return id;
      }
      case "end":
        this.end(runId, event.outcome, event.error);
        return undefined;
      default:
        return undefined;
    }
  }

  /** Closes what is still open when a run ends, and flushes its pending updates. */
  end(
    runId: string,
    outcome: Extract<AgentEvent, { type: "end" }>["outcome"],
    error?: string,
  ): void {
    const t = this.#runs.get(runId);
    if (t === undefined) return;
    const at = this.#iso();
    this.#closeText(t, at);
    const reason = clip(this.#redact(error ?? "The run failed"), 1000);
    const waiting = outcome === "awaiting_approval" || outcome === "awaiting_input";
    for (const step of t.steps.values()) {
      if (ENDED.has(step.status)) continue;
      if (step.status === "waiting" && waiting) continue;
      // A specialist outlives the run that spawned it: its own turns settle the spawn step.
      if (step.kind === "subagent" && step.taskId !== undefined) continue;
      const status: RunStepStatus =
        step.kind === "thinking" || step.kind === "text"
          ? "ok"
          : outcome === "failed"
            ? "failed"
            : "cancelled";
      this.#put(t, {
        ...step,
        status,
        endedAt: at,
        ...(status === "failed" && step.error === undefined
          ? { error: { code: "run_failed", message: reason, retryable: false } }
          : {}),
      });
    }
    // A run that failed must say why on a step: the budget, a model error or a crash have none.
    if (outcome === "failed" && ![...t.steps.values()].some((s) => s.status === "failed")) {
      this.#put(t, {
        id: this.#newId(),
        kind: "note",
        status: "failed",
        label: clip(reason, RUN_STEP_LIMITS.labelChars),
        startedAt: at,
        endedAt: at,
        error: { code: "run_failed", message: reason, retryable: false },
        ...(t.parentStepId === undefined ? {} : { parentStepId: t.parentStepId }),
      });
    }
    for (const timer of t.progressTimers.values()) clearTimeout(timer);
    if (t.runUpdateTimer !== undefined) clearTimeout(t.runUpdateTimer);
    this.#publishRun(t, true);
    // An awaiting run resumes in a later turn with the same run id: keep its state.
    if (!waiting) {
      this.#runs.delete(runId);
      for (const key of this.#reserved.keys())
        if (key.startsWith(`${runId}|`)) this.#reserved.delete(key);
    }
  }

  // --- Specialists (S02, docs/agent/specialists-2026.md) -----------------------------------

  /** The parent's `subagent` event: its spawn step follows the specialist's job. */
  #specialist(
    t: TraceRun,
    event: Extract<AgentEvent, { type: "subagent" }>,
    at: string,
  ): string | undefined {
    const id = t.byToolCall.get(event.toolCallId);
    const prev = id === undefined ? undefined : t.steps.get(id);
    if (prev === undefined || id === undefined) return undefined;
    const status = SPECIALIST_STATUS[event.status];
    const ended = ENDED.has(status);
    // The spawn call itself returns at once; the step lasts while the specialist works.
    this.#put(t, {
      ...prev,
      kind: "subagent",
      status,
      label: clip(this.#redact(event.label), RUN_STEP_LIMITS.labelChars),
      taskId: event.taskId,
      ...(event.childRunId === null ? {} : { childRunId: event.childRunId }),
      ...(event.progress === undefined || ended
        ? {}
        : {
            progress: { message: clip(this.#redact(event.progress), RUN_STEP_LIMITS.labelChars) },
          }),
      endedAt: ended ? (prev.endedAt ?? at) : null,
    });
    return id;
  }

  /**
   * A specialist's task turn started as its own run: the parent's spawn step for that task
   * points at it (`childRunId`), whether the parent run is still live or long finished.
   */
  linkChild(
    parentRunId: string,
    taskId: string,
    childRunId: string,
    /** When the specialist's turn ended: the spawn step's outcome. */
    status?: RunStepStatus,
  ): void {
    const at = this.#iso();
    const settle = (s: RunStep): RunStep => ({
      ...s,
      childRunId,
      ...(status === undefined
        ? {}
        : { status, endedAt: ENDED.has(status) ? (s.endedAt ?? at) : null }),
      ...(status !== undefined && ENDED.has(status) ? { progress: undefined } : {}),
    });
    const live = this.#runs.get(parentRunId);
    if (live !== undefined) {
      const spawn = [...live.steps.values()]
        .filter((s) => s.kind === "subagent" && s.taskId === taskId)
        .sort((a, b) => b.seq - a.seq)[0];
      if (spawn !== undefined) {
        this.#put(live, settle(spawn));
        return;
      }
    }
    let row: { data: string; thread_id: string } | undefined;
    try {
      row = this.#o.db.sqlite
        .prepare(
          `SELECT s.data, r.thread_id FROM run_steps s JOIN runs r ON r.id = s.run_id
           WHERE s.run_id = ? AND s.kind = 'subagent' AND json_extract(s.data, '$.taskId') = ?
           ORDER BY s.seq DESC LIMIT 1`,
        )
        .get(parentRunId, taskId) as { data: string; thread_id: string } | undefined;
    } catch {
      return;
    }
    if (row === undefined) return;
    const step = settle(JSON.parse(row.data) as RunStep);
    upsertRunStep(this.#o.db, step);
    this.#o.bus.bumpStateVersion();
    this.#o.bus.publish("run.step", { runId: parentRunId, step }, row.thread_id);
  }

  // --- Helpers (C6) ------------------------------------------------------------------------

  /**
   * One event of a helper run (`onSubagentEvent`). The first event creates the helper's own run
   * (`kind: subagent`, `parentRunId`, `rootRunId`) and links it to its spawn step.
   */
  subagent(
    info: { runId: string; parentRunId: string; parentThreadId: string; title: string },
    event: AgentEvent,
  ): void {
    const parent = this.#runs.get(info.parentRunId);
    let childId = this.#helpers.get(info.runId);
    if (childId === undefined) {
      childId = this.#startHelper(info, parent);
      if (childId === undefined) return;
      this.#helpers.set(info.runId, childId);
    }
    this.apply(childId, info.parentThreadId, { ...event, runId: childId } as AgentEvent);
    if (event.type === "usage" && this.#runs.get(childId)?.store === true) {
      // Helper usage is counted on the parent by the loop; the child row shows its own.
      try {
        this.#o.db.sqlite
          .prepare("UPDATE runs SET usage = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(event.usage), this.#iso(), childId);
      } catch {
        // A trace write never fails the turn.
      }
    }
    if (event.type === "end") {
      this.#helpers.delete(info.runId);
      const status =
        event.outcome === "final" || event.outcome === "no_reply"
          ? "done"
          : event.outcome === "cancelled"
            ? "cancelled"
            : "failed";
      if (this.#o.isIncognito?.(info.parentThreadId) !== true) {
        try {
          const run = finishRun(this.#o.db, childId, {
            status,
            ...(event.error === undefined ? {} : { error: this.#redact(event.error) }),
          });
          this.#o.bus.publish("run.updated", { run }, info.parentThreadId);
        } catch {
          // The child row is missing (deleted trace): nothing to finish.
        }
      }
    }
  }

  #startHelper(
    info: { runId: string; parentRunId: string; parentThreadId: string; title: string },
    parent: TraceRun | undefined,
  ): string | undefined {
    const store = this.#o.isIncognito?.(info.parentThreadId) !== true;
    const parentRun = store ? getRun(this.#o.db, info.parentRunId) : undefined;
    // The spawn step: the parent's running `subagent.spawn` call for this title, else the oldest.
    let spawn: RunStep | undefined;
    if (parent !== undefined) {
      const open = [...parent.steps.values()].filter(
        (s) => s.kind === "subagent" && s.childRunId === undefined,
      );
      spawn = open.find((s) => s.label.includes(info.title)) ?? open[0];
    }
    const childId = this.#o.db.newId();
    if (store) {
      if (parentRun === undefined) return undefined;
      const run = createRun(this.#o.db, {
        id: childId,
        threadId: parentRun.threadId,
        modelRef: parentRun.modelRef,
        kind: "subagent",
        origin: "subagent",
        title: clip(this.#redact(info.title), RUN_STEP_LIMITS.labelChars),
        parentRunId: parentRun.id,
        rootRunId: parentRun.rootRunId ?? parentRun.id,
        ...(parentRun.taskId == null ? {} : { taskId: parentRun.taskId }),
      });
      this.#o.bus.publish("run.updated", { run }, info.parentThreadId);
    }
    this.begin(childId, info.parentThreadId);
    const child = this.#runs.get(childId) as TraceRun;
    if (spawn !== undefined && parent !== undefined) {
      child.parentStepId = spawn.id;
      this.#put(parent, { ...spawn, childRunId: childId });
    }
    return childId;
  }

  // --- Tool results (tool_result_persist) --------------------------------------------------

  /**
   * The loop's `tool_result_persist` hook: the call's input and output become `tool_payloads`
   * (1 MB each, head and tail past it) and short previews on the step.
   */
  toolResult(record: ToolCall, result: ToolResult): void {
    const t = this.#runs.get(record.runId) ?? this.#findByToolCall(record.id);
    const stepId = t?.byToolCall.get(record.id);
    if (t === undefined || stepId === undefined) return;
    const step = t.steps.get(stepId);
    if (step === undefined) return;
    const input = preview(record.paramsRedacted, (x) => this.#redact(x));
    const output = preview(withoutImages(result.output), (x) => this.#redact(x));
    const payloadRef: { input?: string; output?: string } = {};
    if (t.store) {
      const write = (kind: "params" | "result", value: unknown) => {
        if (value === undefined) return undefined;
        let text: string;
        let mime = "application/json";
        try {
          text = typeof value === "string" ? value : JSON.stringify(value);
          if (typeof value === "string") mime = "text/plain";
        } catch {
          return undefined;
        }
        if (text === undefined) return undefined;
        const capped = capPayload(this.#redact(text));
        try {
          const ref = putToolPayload(this.#o.db, {
            toolCallId: record.id,
            stepId,
            kind,
            mime: capped.truncated ? "text/plain" : mime,
            data: new TextEncoder().encode(capped.text),
            truncated: capped.truncated,
          });
          return ref.replace(/^payload:/, "");
        } catch {
          return undefined;
        }
      };
      const i = write("params", record.paramsRedacted);
      const o = write("result", withoutImages(result.output));
      if (i !== undefined) payloadRef.input = i;
      if (o !== undefined) payloadRef.output = o;
    }
    // Why a call failed is what it said: the step's error carries the tool's own message.
    const why =
      result.isError === true && step.status === "failed"
        ? clip(this.#redact(errorText(result.output)), 1000)
        : "";
    this.#put(t, {
      ...step,
      ...(why === ""
        ? {}
        : {
            error: {
              code: step.error?.code ?? "tool_failed",
              message: why,
              retryable: step.error?.retryable ?? true,
            },
          }),
      ...(input === undefined && output === undefined
        ? {}
        : {
            preview: {
              ...(input === undefined ? {} : { input }),
              ...(output === undefined ? {} : { output }),
            },
          }),
      ...(Object.keys(payloadRef).length === 0 ? {} : { payloadRef }),
      ...(result.receiptId === undefined ? {} : { receiptId: result.receiptId }),
    });
  }

  // --- Model calls (model_call_persist) -----------------------------------------------------

  /**
   * The loop's `model_call_persist` hook: the call's input (system, messages, tools offered) and
   * output (text, tool calls, stop reason, usage) become the newest model step's payloads. Both
   * are redacted and capped at `MODEL_PAYLOAD_BYTES` (head and tail kept, `truncated` set), and
   * carry the run's taint so the Timeline can show it.
   */
  modelCall(ctx: {
    runId: string;
    system: string;
    messages: readonly ModelMessage[];
    tools: readonly ToolSpec[];
    output: {
      text: string;
      calls: readonly { id: string; name: string; input: unknown }[];
      finish: string;
      error?: string;
    };
    taint: boolean;
  }): void {
    const t = this.#runs.get(ctx.runId);
    const stepId = t?.lastModelStepId;
    if (t === undefined || stepId === undefined) return;
    const step = t.steps.get(stepId);
    if (step === undefined) return;
    const input = {
      system: ctx.system,
      messages: ctx.messages.map((m) => ({
        role: m.role,
        parts: m.parts.flatMap((p) => {
          // Opaque reasoning envelopes and inline images are not readable: leave a marker.
          if (p.type === "reasoning") return [{ type: "reasoning" }];
          if (p.type === "image") return [{ type: "image", mime: p.mime }];
          return [p];
        }),
      })),
      tools: ctx.tools.map((x) => ({ name: x.name, description: x.description })),
      taint: ctx.taint,
    };
    const output = {
      text: ctx.output.text,
      toolCalls: ctx.output.calls,
      stopReason: ctx.output.finish,
      ...(ctx.output.error === undefined ? {} : { error: ctx.output.error }),
      ...(step.usage === undefined ? {} : { usage: step.usage }),
      taint: ctx.taint,
    };
    const payloadRef: { input?: string; output?: string } = {};
    if (t.store) {
      const write = (kind: "input" | "output", value: unknown) => {
        try {
          const capped = capPayload(this.#redact(JSON.stringify(value)), MODEL_PAYLOAD_BYTES);
          return putStepPayload(this.#o.db, {
            runId: t.runId,
            stepId,
            kind,
            text: capped.text,
            truncated: capped.truncated,
          });
        } catch {
          return undefined;
        }
      };
      const i = write("input", input);
      const o = write("output", output);
      if (i !== undefined) payloadRef.input = i;
      if (o !== undefined) payloadRef.output = o;
    }
    const lastUser = [...ctx.messages].reverse().find((m) => m.role === "user");
    const asked = lastUser?.parts.find((p) => p.type === "text");
    const inPreview = clip(
      this.#redact(
        `${ctx.messages.length} messages, ${ctx.tools.length} tools${
          asked?.type === "text" ? `: ${asked.text}` : ""
        }`,
      ),
      RUN_STEP_LIMITS.previewBytes,
    );
    const outText =
      ctx.output.text !== ""
        ? ctx.output.text
        : ctx.output.calls.length > 0
          ? `Called ${ctx.output.calls.map((c) => c.name).join(", ")}`
          : (ctx.output.error ?? "");
    const failed = ctx.output.finish === "error";
    const cancelled = ctx.output.finish === "cancelled";
    this.#put(t, {
      ...step,
      ...(failed
        ? {
            status: "failed" as const,
            error: {
              code: "model_error",
              message: clip(this.#redact(ctx.output.error ?? "The model call failed"), 1000),
              retryable: true,
            },
          }
        : cancelled
          ? { status: "cancelled" as const }
          : {}),
      preview: {
        input: inPreview,
        ...(outText === ""
          ? {}
          : { output: clip(this.#redact(outText), RUN_STEP_LIMITS.previewBytes) }),
      },
      ...(Object.keys(payloadRef).length === 0 ? {} : { payloadRef }),
    });
  }

  #findByToolCall(toolCallId: string): TraceRun | undefined {
    for (const t of this.#runs.values()) if (t.byToolCall.has(toolCallId)) return t;
    return undefined;
  }

  // --- Event kinds ---------------------------------------------------------------------------

  #reasoning(t: TraceRun, event: Extract<AgentEvent, { type: "reasoning" }>, at: string): string {
    const id = event.stepId;
    const prev = t.steps.get(id);
    if (prev === undefined) this.#closeText(t, at);
    const text = (t.thinking.get(id) ?? "") + (event.delta ?? "");
    t.thinking.set(id, text.slice(0, RUN_STEP_LIMITS.thinkingBytes));
    const summarySource = event.summary ?? prev?.text?.summary ?? firstLine(text);
    const summary = clip(this.#redact(summarySource), RUN_STEP_LIMITS.thinkingSummaryChars);
    if (event.done !== true) {
      // Deltas stream on chat.reasoning; the step itself changes only when it starts.
      if (prev !== undefined) return id;
      this.#put(t, {
        id,
        kind: "thinking",
        status: "running",
        label: "Thinking",
        doneLabel: "Thought",
        startedAt: at,
        ...(summary === "" ? {} : { text: { summary } }),
      });
      return id;
    }
    const days = this.#o.reasoningRetentionDays?.() ?? 7;
    const full = t.thinking.get(id) ?? "";
    t.thinking.delete(id);
    const keep = t.store && days > 0 && full !== "";
    this.#put(t, {
      ...(prev ?? {
        id,
        kind: "thinking",
        label: "Thinking",
        doneLabel: "Thought",
        startedAt: at,
      }),
      status: "ok",
      endedAt: at,
      text: {
        summary,
        ...(keep
          ? {
              full: this.#redact(full),
              expiresAt: new Date(this.#o.now().getTime() + days * 86_400_000).toISOString(),
            }
          : {}),
      },
    } as RunStep);
    t.modelSince = at;
    return id;
  }

  #tool(t: TraceRun, event: Extract<AgentEvent, { type: "tool_call" }>, at: string): string {
    let id = t.byToolCall.get(event.toolCallId);
    // A call blocked after the owner (or the policy) said no to its approval is denied, not skipped.
    const status: RunStepStatus =
      event.status === "blocked" && event.details?.approvalId != null
        ? "denied"
        : stepStatus(event.status);
    const label = clip(this.#redact(event.level1 ?? event.tool), RUN_STEP_LIMITS.labelChars);
    const target = event.details?.target?.value;
    if (id === undefined) {
      this.#closeText(t, at);
      const key = `${t.runId}|${event.toolCallId}`;
      const reserved = this.#reserved.get(key);
      this.#reserved.delete(key);
      id = reserved?.stepId ?? this.#newId();
      t.byToolCall.set(event.toolCallId, id);
      const inputPreview =
        event.details?.paramsRedacted === undefined
          ? undefined
          : preview(event.details.paramsRedacted, (x) => this.#redact(x));
      this.#put(t, {
        id,
        kind: SPAWN_TOOLS.has(event.tool) ? "subagent" : "tool",
        status,
        label,
        startedAt: at,
        ...(ENDED.has(status) ? { endedAt: at } : {}),
        toolCallId: event.toolCallId,
        ...(target === undefined
          ? {}
          : { target: clip(this.#redact(target), RUN_STEP_LIMITS.targetChars) }),
        ...(inputPreview === undefined ? {} : { preview: { input: inputPreview } }),
        ...(event.details?.approvalId == null ? {} : { approvalId: event.details.approvalId }),
        ...(t.parentStepId === undefined ? {} : { parentStepId: t.parentStepId }),
        ...(reserved?.memoryPath === undefined ? {} : { memoryPath: reserved.memoryPath }),
        ...(reserved?.frames === undefined ? {} : { frames: reserved.frames }),
        ...this.#group(t, id, status),
      });
      if (status === "running") t.runningTools.add(id);
      return id;
    }
    const prev = t.steps.get(id) as RunStep;
    // A progress update of a running call: throttled, the rest of the step unchanged.
    if (event.update !== undefined && status === "running" && prev.status === "running") {
      const message =
        event.update.message === undefined
          ? undefined
          : clip(this.#redact(event.update.message), RUN_STEP_LIMITS.labelChars);
      const fraction =
        typeof event.update.progress === "number"
          ? Math.min(
              1,
              Math.max(
                0,
                event.update.progress > 1 ? event.update.progress / 100 : event.update.progress,
              ),
            )
          : undefined;
      this.#progress(t, {
        ...prev,
        progress: {
          ...(message === undefined ? {} : { message }),
          ...(fraction === undefined ? {} : { fraction }),
        },
      });
      return id;
    }
    // A call that runs again after it ended is a retry: one more attempt on the same step.
    const retry = status === "running" && ENDED.has(prev.status);
    const attempts = retry
      ? [
          ...(prev.attempts ?? []),
          {
            startedAt: prev.startedAt,
            endedAt: prev.endedAt ?? at,
            status: prev.status,
            ...(prev.error === undefined ? {} : { error: prev.error }),
          },
        ].slice(-RUN_STEP_LIMITS.earlierAttempts)
      : prev.attempts;
    const ended = ENDED.has(status);
    const next: RunStep = {
      ...prev,
      status,
      label,
      ...(retry ? { attempt: prev.attempt + 1, startedAt: at, endedAt: null } : {}),
      ...(attempts === undefined ? {} : { attempts }),
      ...(ended ? { endedAt: at } : {}),
      ...(target === undefined
        ? {}
        : { target: clip(this.#redact(target), RUN_STEP_LIMITS.targetChars) }),
      ...(event.details?.approvalId == null ? {} : { approvalId: event.details.approvalId }),
      ...(event.details?.receiptId == null ? {} : { receiptId: event.details.receiptId }),
    };
    if (retry) delete next.error;
    if (ended) delete next.progress;
    if (status === "failed") {
      next.error = {
        code: event.status === "uncertain" ? "uncertain" : "tool_failed",
        message: label,
        retryable: event.status !== "uncertain",
      };
    }
    if (status === "running") t.runningTools.add(id);
    else t.runningTools.delete(id);
    if (ended && t.runningTools.size === 0) t.modelSince = at;
    // A specialist's spawn call returns at once: its step follows the job (`subagent` events).
    if (prev.kind === "subagent" && prev.taskId !== undefined && status === "ok") {
      this.#put(t, { ...next, status: prev.status, endedAt: prev.endedAt, label: prev.label });
      return id;
    }
    this.#put(t, next);
    return id;
  }

  /** A tool call that starts while another of the run is running joins (or opens) its group. */
  #group(t: TraceRun, id: string, status: RunStepStatus): { groupId?: string } {
    if (status !== "running" || t.runningTools.size === 0) return {};
    const others = [...t.runningTools].map((x) => t.steps.get(x)).filter((s) => s !== undefined);
    const existing = others.find((s) => s.groupId !== undefined)?.groupId;
    const groupId = existing ?? `grp_${id.slice(STEP_ID_PREFIX.length)}`;
    for (const s of others) if (s.groupId === undefined) this.#put(t, { ...s, groupId });
    return { groupId };
  }

  /** A model step covers one call: from what it waited on to its `usage` (§4.2). */
  #model(t: TraceRun, usage: Usage, at: string): string {
    const id = this.#newId();
    const delta = subUsage(usage, t.lastUsage);
    t.lastUsage = usage;
    t.lastModelStepId = id;
    const run = t.store ? getRun(this.#o.db, t.runId) : undefined;
    this.#put(t, {
      id,
      kind: "model",
      status: "ok",
      label: "Model call",
      startedAt: t.modelSince,
      endedAt: at,
      ...(run === undefined ? {} : { modelRef: run.modelRef }),
      usage: delta,
      ...(t.parentStepId === undefined ? {} : { parentStepId: t.parentStepId }),
    });
    t.modelSince = at;
    if (t.store) {
      try {
        // The router writes the usage row; link the run's newest unlinked one to this step.
        this.#o.db.sqlite
          .prepare(
            "UPDATE usage SET step_id = ? WHERE id = (SELECT id FROM usage WHERE run_id = ? AND step_id IS NULL ORDER BY created_at DESC LIMIT 1)",
          )
          .run(id, t.runId);
      } catch {
        // Usage rows are best effort.
      }
    }
    return id;
  }

  #closeText(t: TraceRun, at: string): void {
    const open = t.text;
    if (open === undefined) return;
    t.text = undefined;
    const step = t.steps.get(open.stepId);
    if (step !== undefined && !ENDED.has(step.status))
      this.#put(t, { ...step, status: "ok", endedAt: at });
  }

  /** A wait (approval, question) ends with the run's next event. */
  #closeWaits(t: TraceRun, at: string, event: AgentEvent): void {
    if (t.waits.size === 0) return;
    if (
      event.type === "end" &&
      (event.outcome === "awaiting_approval" || event.outcome === "awaiting_input")
    )
      return;
    for (const id of t.waits) {
      const step = t.steps.get(id);
      if (step === undefined) continue;
      // The call it was for went ahead (approved) or was blocked (declined).
      const declined =
        event.type === "tool_call" &&
        event.status === "blocked" &&
        step.approvalId !== undefined &&
        event.details?.approvalId === step.approvalId;
      this.#put(t, { ...step, status: declined ? "denied" : "ok", endedAt: at });
    }
    t.waits.clear();
    t.modelSince = at;
  }

  // --- Writes and events ---------------------------------------------------------------------

  #newId(): string {
    return `${STEP_ID_PREFIX}${this.#o.db.newId()}`;
  }

  /** Stores and publishes a step (new or changed). New steps take the next seq. */
  #put(
    t: TraceRun,
    partial: Omit<RunStep, "runId" | "seq" | "attempt" | "endedAt"> &
      Partial<Pick<RunStep, "seq" | "attempt" | "endedAt">>,
  ): void {
    const prev = t.steps.get(partial.id);
    let seq = prev?.seq ?? partial.seq;
    if (seq === undefined) {
      if (t.seq >= RUN_STEP_LIMITS.stepsPerRun) {
        // §4.5: past the cap, new steps are folded away and the run says so.
        if (!t.folded) {
          t.folded = true;
          if (t.store) patchRunTrace(this.#o.db, t.runId, { note: "Some steps were folded" });
          this.#publishRun(t, true);
        }
        return;
      }
      t.seq += 1;
      seq = t.seq;
    }
    const step: RunStep = {
      ...partial,
      runId: t.runId,
      seq,
      attempt: partial.attempt ?? prev?.attempt ?? 1,
      endedAt: partial.endedAt ?? null,
    } as RunStep;
    t.steps.set(step.id, step);
    const timer = t.progressTimers.get(step.id);
    if (timer !== undefined) {
      clearTimeout(timer);
      t.progressTimers.delete(step.id);
    }
    this.#write(t, step, prev === undefined);
  }

  #progress(t: TraceRun, step: RunStep): void {
    t.steps.set(step.id, step);
    const now = this.#o.now().getTime();
    const last = t.progressAt.get(step.id) ?? 0;
    if (now - last >= PROGRESS_INTERVAL_MS) {
      t.progressAt.set(step.id, now);
      this.#write(t, step, false);
      return;
    }
    if (t.progressTimers.has(step.id)) return;
    // Trailing: the last progress of a burst always arrives.
    const timer = setTimeout(
      () => {
        t.progressTimers.delete(step.id);
        t.progressAt.set(step.id, this.#o.now().getTime());
        const current = t.steps.get(step.id);
        if (current !== undefined) this.#write(t, current, false);
      },
      PROGRESS_INTERVAL_MS - (now - last),
    );
    timer.unref?.();
    t.progressTimers.set(step.id, timer);
  }

  #write(t: TraceRun, step: RunStep, isNew: boolean): void {
    if (t.store) {
      try {
        upsertRunStep(this.#o.db, step);
        this.#o.bus.bumpStateVersion();
      } catch (err) {
        // A trace write never fails the turn; the step still streams.
        void err;
      }
    }
    // `run.step` never carries the retained thinking text (§4.4).
    let sent = step;
    if (step.text?.full !== undefined) {
      const { full: _full, ...text } = step.text;
      sent = { ...step, text };
    }
    this.#o.bus.publish("run.step", { runId: t.runId, step: sent }, t.threadId);
    if (isNew) this.#publishRun(t, false);
    else if (step.status !== "running" || step.kind !== "tool") this.#publishRun(t, false);
  }

  /** Keeps the run's step count and current step, published at most once a second. */
  #publishRun(t: TraceRun, now: boolean): void {
    const send = () => {
      t.runUpdateTimer = undefined;
      t.runUpdateAt = this.#o.now().getTime();
      const current = [...t.steps.values()]
        .filter((s) => !ENDED.has(s.status))
        .sort((a, b) => b.seq - a.seq)[0];
      if (!t.store) return;
      let run: Run | undefined;
      try {
        run = patchRunTrace(this.#o.db, t.runId, {
          stepCount: t.seq,
          currentStepId: current?.id ?? null,
          lastStepAt: this.#iso(),
        });
      } catch {
        return;
      }
      if (run !== undefined) this.#o.bus.publish("run.updated", { run }, t.threadId);
    };
    if (now) {
      if (t.runUpdateTimer !== undefined) clearTimeout(t.runUpdateTimer);
      send();
      return;
    }
    if (t.runUpdateTimer !== undefined) return;
    const wait = RUN_UPDATE_INTERVAL_MS - (this.#o.now().getTime() - t.runUpdateAt);
    if (wait <= 0) {
      send();
      return;
    }
    t.runUpdateTimer = setTimeout(send, wait);
    t.runUpdateTimer.unref?.();
  }
}

/** A screenshot's inline base64 is a frame now: the payload keeps a reference (§4.2). */
function withoutImages(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const v = value as Record<string, unknown>;
  if (typeof v.base64 !== "string" || v.base64.length < 1024) return value;
  return { ...v, base64: "‹frame›" };
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}
