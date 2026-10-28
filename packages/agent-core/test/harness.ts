import type {
  AgentEvent,
  ApprovalRequestInput,
  IssuedApproval,
  ModelEvent,
  ModelRequest,
  PermissionMode,
  Requester,
  RunMode,
  StartTurnInput,
  ToolResult,
  ToolSpec,
} from "@psyche/protocol";
import {
  createIdGenerator,
  FakeClock,
  FakeMemoryStore,
  FakeModelProvider,
  FakeNotifier,
  FakePermissionBroker,
  type FakePolicy,
  FakeScheduler,
  FakeSkillLoader,
  FakeTaskEngine,
  type ScriptedTurn,
} from "@psyche/testing";
import { type AgentLoopOptions, createAgentLoop, type PsycheAgentLoop } from "../src/index.ts";

/** Broker fake that keeps the answer tokens it issues, so tests can answer like a device. */
export class RecordingBroker extends FakePermissionBroker {
  readonly issued: IssuedApproval[] = [];

  override async requestApproval(input: ApprovalRequestInput): Promise<IssuedApproval> {
    const issued = await super.requestApproval(input);
    this.issued.push(issued);
    return issued;
  }

  /** Approve or deny the latest (or given) request from the desktop surface. */
  async decideLatest(
    decision: "approve" | "deny",
    clock: FakeClock,
    approvalId?: string,
  ): Promise<void> {
    const issued =
      approvalId === undefined
        ? this.issued.at(-1)
        : this.issued.find((i) => i.approval.id === approvalId);
    if (issued === undefined) throw new Error("no approval issued");
    clock.advance(500); // past the 400 ms arm delay
    const surface = Object.keys(issued.answerTokens)[0] as string;
    await this.answer({
      approvalId: issued.approval.id,
      answerToken: issued.answerTokens[surface] as string,
      decision,
      decidedBy: { deviceId: "dev_owner", surface },
    });
  }
}

export interface HarnessOptions {
  script?: ScriptedTurn[];
  policy?: FakePolicy;
  files?: Record<string, string>;
  loop?: Partial<AgentLoopOptions>;
  contextWindow?: number;
  vision?: boolean;
}

export function harness(options: HarnessOptions = {}) {
  const clock = new FakeClock();
  const ids = createIdGenerator();
  const provider = new FakeModelProvider({
    ...(options.contextWindow === undefined && options.vision === undefined
      ? {}
      : {
          capabilities: {
            ...(options.contextWindow === undefined
              ? {}
              : { contextWindow: options.contextWindow }),
            ...(options.vision === undefined ? {} : { vision: options.vision }),
          },
        }),
  }).script(options.script ?? []);
  const broker = new RecordingBroker({ clock, ids, policy: options.policy ?? {} });
  const memory = new FakeMemoryStore({ clock, ids, files: options.files ?? {} });
  const tasks = new FakeTaskEngine({ clock, ids });
  const notifier = new FakeNotifier({ clock, ids });
  const scheduler = new FakeScheduler({ clock, ids });
  const skills = new FakeSkillLoader({ ids });
  const loop: PsycheAgentLoop = createAgentLoop({
    provider,
    model: "fake/main",
    utilityModel: "fake/utility",
    broker,
    memory,
    tasks,
    notifier,
    scheduler,
    skills,
    clock,
    ids,
    ...options.loop,
  });
  return { clock, ids, provider, broker, memory, tasks, notifier, scheduler, skills, loop };
}

export type Harness = ReturnType<typeof harness>;

let runCounter = 0;

export interface TurnOptions {
  threadId?: string;
  runId?: string;
  taskId?: string;
  mode?: RunMode;
  permissionMode?: PermissionMode;
  signal?: AbortSignal;
  requester?: Requester;
}

export function turnInput(text: string, o: TurnOptions = {}): StartTurnInput {
  runCounter += 1;
  return {
    threadId: o.threadId ?? "thr_1",
    runId: o.runId ?? `run_${runCounter}`,
    ...(o.taskId === undefined ? {} : { taskId: o.taskId }),
    input: { text },
    mode: o.mode ?? "attended",
    permissionMode: o.permissionMode ?? "balanced",
    ...(o.signal === undefined ? {} : { signal: o.signal }),
    ...(o.requester === undefined ? {} : { requester: o.requester }),
  };
}

/** Start a turn in the background; `events` fills as it runs, `done` resolves at `end`. */
export function start(h: Harness, text: string, o: TurnOptions = {}) {
  const input = turnInput(text, o);
  const events: AgentEvent[] = [];
  const done = (async () => {
    for await (const e of h.loop.startTurn(input)) events.push(e);
    return events;
  })();
  return { input, events, done, runId: input.runId };
}

export async function runTurn(h: Harness, text: string, o: TurnOptions = {}) {
  return start(h, text, o).done;
}

/** Let the run make progress until `predicate` holds (fails after many idle ticks). */
export async function until(predicate: () => boolean, label = "condition"): Promise<void> {
  // Ticks, not time: a loaded CI runner needs far more than 2 000 event-loop turns for real I/O
  // (sqlite, fs, child processes), so the bound is generous and backed by a wall-clock limit.
  const deadline = Date.now() + 15_000;
  for (let i = 0; i < 200_000; i++) {
    if (predicate()) return;
    if (Date.now() > deadline) break;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for ${label}`);
}

export function endOf(events: AgentEvent[]) {
  const end = events.find((e) => e.type === "end");
  if (end === undefined || end.type !== "end") throw new Error("no end event");
  return end;
}

export function text(events: AgentEvent[]): string {
  return events.map((e) => (e.type === "chat.delta" ? e.delta : "")).join("");
}

export function blocks(events: AgentEvent[]) {
  return events.flatMap((e) => (e.type === "block" ? [e.block] : []));
}

export function toolStatuses(events: AgentEvent[], toolCallId: string): string[] {
  return events.flatMap((e) =>
    e.type === "tool_call" && e.toolCallId === toolCallId ? [e.status] : [],
  );
}

// --- Scripted model turns ------------------------------------------------------------------

const usage = (input = 10, output = 5): ModelEvent => ({
  type: "usage",
  usage: { input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
});

export function say(t: string, tokens?: { input: number; output: number }): ModelEvent[] {
  return [
    { type: "text_delta", text: t },
    usage(tokens?.input, tokens?.output),
    { type: "finish", reason: "stop" },
  ];
}

export function calls(...c: { id: string; name: string; input: unknown }[]): ModelEvent[] {
  return [
    ...c.map((x): ModelEvent => ({ type: "tool_call", ...x })),
    usage(),
    { type: "finish", reason: "tool_calls" },
  ];
}

export function call(id: string, name: string, input: unknown = {}): ModelEvent[] {
  return calls({ id, name, input });
}

/** The tool results the model saw in a request, by call id. */
export function resultsIn(request: ModelRequest | undefined) {
  const out = new Map<string, { output: unknown; isError?: boolean; provenance?: string }>();
  for (const m of request?.messages ?? []) {
    for (const p of m.parts) {
      if (p.type === "tool_result") {
        out.set(p.callId, {
          output: p.output,
          ...(p.isError === undefined ? {} : { isError: p.isError }),
          ...(p.provenance === undefined ? {} : { provenance: p.provenance }),
        });
      }
    }
  }
  return out;
}

export function spec(
  name: string,
  sideEffect: ToolSpec["sideEffect"],
  extra: Partial<ToolSpec> = {},
): ToolSpec {
  return {
    name,
    description: `${name} (test tool)`,
    inputSchema: { type: "object" },
    sideEffect,
    provenanceOut: "trusted",
    ...extra,
  };
}

/** A plain executor (the shape other packages register) that records its calls. */
export function recorder(result: Partial<ToolResult> = {}) {
  const seen: { callId: string; params: unknown }[] = [];
  const execute = async (callId: string, params: unknown): Promise<ToolResult> => {
    seen.push({ callId, params });
    return { output: { ok: true }, provenance: "trusted", ...result };
  };
  return { seen, execute };
}
