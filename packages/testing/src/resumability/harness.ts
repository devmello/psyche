import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ApprovalRequest,
  CallOptions,
  IssuedApproval,
  ModelEvent,
  ModelMessage,
  ModelRequest,
  Receipt,
  ReceiptInput,
  SideEffect,
  Task,
  TaskAction,
  TaskCheckpoint,
  ToolCallDescription,
} from "@psyche/protocol";
import { captureModelVisible, describeLeak, peekCaptures, scanCaptures } from "../capture.ts";
import { FakeClock } from "../clock.ts";
import { FakeModelProvider } from "../fakes/FakeModelProvider.ts";
import { registerSecret, unregisterSecret } from "../secrets.ts";
import {
  bootGeneration,
  type Generation,
  type PolicyConfig,
  type ToolRunContext,
} from "./stack.ts";

// --- Scripts, tools and the provider ledger -------------------------------------------------

/** One model event: a tool call (one per model response) or the final answer (last step). */
export type ScriptStep =
  | { id: string; tool: string; input: Record<string, unknown> }
  | { id: string; text: string; claims?: string[] };

export interface ResumabilityScript {
  title: string;
  goal: string;
  steps: ScriptStep[];
}

/** A side effect the third party holds; it survives every crash. */
export interface LedgerEffect {
  providerId: string;
  tool: string;
  step: string;
  callId: string;
  approvalId: string | null;
  generation: number;
  input: Record<string, unknown>;
}

export interface EffectContext {
  callId: string;
  step: string;
  approvalId: string | null;
  generation: number;
  ledger: ProviderLedger;
}

/** The third party (mail provider): effects are keyed by the call id, its idempotency key. */
export class ProviderLedger {
  readonly effects: LedgerEffect[] = [];
  /** The provider credential the executors hold; it must never become model-visible. */
  readonly credential = "psy-provider-token-7f3a9c2e5b1d";

  apply(tool: string, input: Record<string, unknown>, ctx: EffectContext): LedgerEffect {
    const providerId = `sent_${String(this.effects.length + 1).padStart(4, "0")}`;
    const { callId, step, approvalId, generation } = ctx;
    const effect = { providerId, tool, step, callId, approvalId, generation, input };
    this.effects.push(effect);
    return effect;
  }

  byCallId(callId: string): LedgerEffect | undefined {
    return this.effects.find((e) => e.callId === callId);
  }
}

export interface ResumabilityTool {
  name: string;
  sideEffect: SideEffect;
  describe?: (input: Record<string, unknown>) => ToolCallDescription;
  /** Talks to the third party; writes go through `ctx.ledger.apply`. */
  call: (input: Record<string, unknown>, ctx: EffectContext) => unknown;
}

export const inboxRead: ResumabilityTool = {
  name: "inbox.read",
  sideEffect: "read",
  call: () => ({
    messages: [{ id: "msg_0001", from: "bob@example.com", subject: "Lunch Friday?" }],
  }),
};

export const emailSend: ResumabilityTool = {
  name: "email.send",
  sideEffect: "write",
  describe: (input) => ({
    kind: "send_email",
    target: { kind: "recipient", value: String(input.to) },
    summary: `Send an email to ${String(input.to)}`,
  }),
  call: (input, ctx) => ({ messageId: ctx.ledger.apply("email.send", input, ctx).providerId }),
};

// --- Kill points and reports ----------------------------------------------------------------

export type KillKind =
  | "after_model_event"
  | "while_awaiting_approval"
  | "before_dispatch"
  | "after_dispatch"
  | "before_receipt"
  | "after_receipt";
/** `after_model_event:<n>` (0…steps) or `<kind>:<step id>` (tests/scenarios/README.md). */
export type KillPoint = `${KillKind}:${string}`;

export type Outcome =
  | "no_kill"
  | "not_reached"
  | "resumes"
  | "replays_safe_read"
  | "reconciles_uncertain"
  | "reissues_approval";

export type ViolationCode =
  | "duplicate_effect"
  | "replayed_dispatch"
  | "effect_without_receipt"
  | "duplicate_receipt"
  | "receipt_without_effect"
  | "reconciled_wrong"
  | "unreconciled_uncertain"
  | "task_state"
  | "claim_without_receipt"
  | "transcript_without_receipt"
  | "stale_approval"
  | "stale_pending_approval"
  | "secret_leak"
  | "stuck"
  | "unexpected_outcome";

export interface Violation {
  code: ViolationCode;
  message: string;
}

export interface ResumabilityOptions {
  script: ResumabilityScript;
  /** Default `[inboxRead, emailSend]`. */
  tools?: ResumabilityTool[];
  /** Default: `email.send` asks, `inbox.read` is allowed. */
  policy?: PolicyConfig;
  /**
   * `settle` (default): the hang lasts until the dying process has persisted its queued work (the
   * step is checkpointed `running`), then it dies. `instant`: it dies the moment the point is hit.
   */
  crash?: "settle" | "instant";
  /** Acceptable final task states (default `done`). */
  expectStatus?: Task["status"][];
  /** Deliberate bugs, for proving that the harness catches them. */
  faults?: {
    isReplaySafe?: (tool: string) => boolean;
    /** `replay`: settle uncertain steps as failed without asking the provider. */
    reconcile?: "provider" | "replay";
    /** The executor of this tool applies the effect twice. */
    doubleApply?: string;
    /** Tool results carry the provider credential. */
    leakCredential?: boolean;
  };
}

export interface RunWithKillOptions extends ResumabilityOptions {
  /** Where the one SIGKILL lands (generation 0 only); omitted = an uninterrupted baseline run. */
  killAt?: KillPoint;
}

export interface RunReport {
  killPoint: KillPoint | null;
  outcome: Outcome;
  expected: Outcome[];
  violations: Violation[];
  generations: number;
  task: Task | undefined;
  ledger: LedgerEffect[];
  receipts: Receipt[];
  checkpoints: TaskCheckpoint[];
  approvals: (ApprovalRequest & { generation: number })[];
  dispatches: { step: string; callId: string; tool: string; generation: number }[];
  reconciled: { stepId: string; status: "done" | "failed" }[];
  notes: string[];
}

const THREAD = "thr_resume";
const LEASE_MS = 30_000;
const MAX_TURNS = 8;
const SAFE: readonly SideEffect[] = ["none", "read"];
const DEFAULT_POLICY: PolicyConfig = { ask: ["email.send"], allow: ["inbox.read"] };

const never = <T>(): Promise<T> => new Promise<T>(() => {});
const stepOf = (callId: string) => callId.slice(0, callId.lastIndexOf(".")) || callId;
const isCall = (s: ScriptStep): s is Extract<ScriptStep, { tool: string }> => "tool" in s;

async function settle(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((r) => setImmediate(r));
}

function usage(): ModelEvent {
  return {
    type: "usage",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
  };
}

/** Every kill point of a script, in a fixed order. */
export function enumerateKillPoints(
  script: ResumabilityScript,
  tools: ResumabilityTool[] = [inboxRead, emailSend],
): KillPoint[] {
  const points: KillPoint[] = [];
  for (let n = 0; n <= script.steps.length; n += 1) points.push(`after_model_event:${n}`);
  for (const step of script.steps.filter(isCall)) {
    const safe = SAFE.includes(tools.find((t) => t.name === step.tool)?.sideEffect ?? "write");
    if (safe) points.push(`before_dispatch:${step.id}`, `after_dispatch:${step.id}`);
    else {
      points.push(
        `while_awaiting_approval:${step.id}`,
        `before_dispatch:${step.id}`,
        `before_receipt:${step.id}`,
        `after_receipt:${step.id}`,
      );
    }
  }
  return points;
}

function expectedFor(kill: KillPoint | null, safe: boolean, instant: boolean): Outcome[] {
  if (kill === null) return ["no_kill"];
  const kind = kill.slice(0, kill.indexOf(":")) as KillKind;
  switch (kind) {
    case "after_model_event":
      return ["resumes", "replays_safe_read"];
    case "while_awaiting_approval":
      return ["reissues_approval"];
    case "before_dispatch":
      // The loop awaits the pool's `running` checkpoint before dispatch (#63), so even an
      // instant kill leaves an in-flight step: `instant` expects what `settle` does.
      void instant;
      return safe ? ["replays_safe_read"] : ["reconciles_uncertain"];
    case "after_dispatch":
      return ["replays_safe_read"];
    case "before_receipt":
      return ["reconciles_uncertain"];
    case "after_receipt":
      return ["resumes", "reconciles_uncertain"];
  }
}

// --- One scripted run with at most one SIGKILL ----------------------------------------------

class Run {
  readonly o: ResumabilityOptions;
  readonly tools: ResumabilityTool[];
  readonly kill: { kind: KillKind; target: string } | undefined;
  readonly clock = new FakeClock();
  readonly ledger = new ProviderLedger();
  readonly model = new FakeModelProvider({ id: "resumability" });
  readonly threads = new Map<string, unknown>();
  readonly attempts = new Map<string, number>();
  readonly dispatches: RunReport["dispatches"] = [];
  readonly issuedIn = new Map<string, number>();
  readonly reconciled: RunReport["reconciled"] = [];
  readonly notes: string[] = [];
  readonly gens: Generation[] = [];
  readonly unsafe: Set<string>;
  readonly file: string;
  fired = false;
  #killed: () => void = () => {};
  readonly killed = new Promise<void>((r) => {
    this.#killed = r;
  });

  constructor(o: ResumabilityOptions, killAt: KillPoint | undefined, file: string) {
    this.file = file;
    this.o = o;
    this.tools = o.tools ?? [inboxRead, emailSend];
    this.unsafe = new Set(
      this.tools.filter((t) => !SAFE.includes(t.sideEffect)).map((t) => t.name),
    );
    if (killAt !== undefined) {
      const i = killAt.indexOf(":");
      this.kill = { kind: killAt.slice(0, i) as KillKind, target: killAt.slice(i + 1) };
    }
  }

  shouldKill(kind: KillKind, target: string, gen: Generation): boolean {
    return (
      !this.fired && gen.index === 0 && this.kill?.kind === kind && this.kill.target === target
    );
  }

  /** SIGKILL: optionally let queued work persist, then stop every timer and write. */
  async fire(gen: Generation): Promise<never> {
    if (!this.fired) {
      this.fired = true;
      if (this.o.crash !== "instant") await settle();
      gen.alive = false;
      this.#killed();
    }
    return never();
  }

  /** A compliant model: the next step the system does not report done or uncertain. */
  next(request: ModelRequest): number {
    const state = new Map<string, "done" | "failed">();
    for (const m of request.messages) {
      for (const p of m.parts) {
        if (p.type === "tool_result") state.set(p.callId, p.isError === true ? "failed" : "done");
        if (m.role !== "user" || p.type !== "text") continue;
        const completed = /Completed steps: (.+)$/m.exec(p.text)?.[1] ?? "";
        const uncertain = /Uncertain steps \([^)]*\): (.+)$/m.exec(p.text)?.[1] ?? "";
        for (const id of `${completed}, ${uncertain}`.split(", ")) if (id) state.set(id, "done");
        for (const r of p.text.matchAll(/Step (\S+) was reconciled as (done|failed)/g)) {
          state.set(r[1] as string, r[2] as "done" | "failed");
        }
      }
    }
    const done = new Set([...state].filter(([, s]) => s === "done").map(([id]) => stepOf(id)));
    const index = this.o.script.steps.findIndex((s) => isCall(s) && !done.has(s.id));
    return index === -1 ? this.o.script.steps.length - 1 : index;
  }

  /** The model response for step `index`; every attempt at a call gets a fresh call id. */
  events(index: number): ModelEvent[] {
    const step = this.o.script.steps[index] as ScriptStep;
    if (!isCall(step)) {
      return [{ type: "text_delta", text: step.text }, usage(), { type: "finish", reason: "stop" }];
    }
    const attempt = (this.attempts.get(step.id) ?? 0) + 1;
    this.attempts.set(step.id, attempt);
    const id = `${step.id}.${attempt}`;
    return [
      { type: "tool_call", id, name: step.tool, input: step.input },
      usage(),
      { type: "finish", reason: "tool_calls" },
    ];
  }

  async *stream(gen: Generation, request: ModelRequest, options?: CallOptions) {
    const index = this.next(request);
    const last = this.o.script.steps.length;
    if (this.shouldKill("after_model_event", String(index), gen)) await this.fire(gen);
    const hangAtEnd = index === last - 1 && this.shouldKill("after_model_event", `${last}`, gen);
    this.model.enqueue(this.events(index));
    for await (const ev of this.model.stream(request, options)) {
      if (hangAtEnd && ev.type === "finish") await this.fire(gen);
      yield ev;
    }
  }

  async dispatch(gen: Generation, tool: ResumabilityTool, params: unknown, ctx: ToolRunContext) {
    const step = stepOf(ctx.callId);
    this.dispatches.push({ step, callId: ctx.callId, tool: tool.name, generation: gen.index });
    if (this.shouldKill("before_dispatch", step, gen)) await this.fire(gen);
    await Promise.resolve(); // the network hop
    if (!gen.alive) return never<never>();
    const input = params as Record<string, unknown>;
    const ectx = {
      callId: ctx.callId,
      step,
      approvalId: ctx.approvalId ?? null,
      ledger: this.ledger,
    };
    let output = tool.call(input, { ...ectx, generation: gen.index });
    if (this.o.faults?.doubleApply === tool.name)
      output = tool.call(input, { ...ectx, generation: gen.index });
    if (this.o.faults?.leakCredential === true) output = { output, auth: this.ledger.credential };
    if (this.shouldKill("after_dispatch", step, gen)) await this.fire(gen);
    return { output, provenance: "trusted" as const };
  }

  async recordReceipt(
    gen: Generation,
    real: (i: ReceiptInput) => Promise<Receipt>,
    input: ReceiptInput,
  ): Promise<Receipt> {
    const step = input.toolCallId == null ? "" : stepOf(input.toolCallId);
    if (this.shouldKill("before_receipt", step, gen)) await this.fire(gen);
    const receipt = await real(input);
    if (this.shouldKill("after_receipt", step, gen)) await this.fire(gen);
    return receipt;
  }

  /** The owner approves every card the live run waits on (or the run is killed instead). */
  onIssued(gen: Generation, issued: IssuedApproval): void {
    this.issuedIn.set(issued.approval.id, gen.index);
    const step = stepOf(issued.approval.requestedBy.toolCallId ?? "");
    setImmediate(() => {
      if (!gen.alive) return;
      if (this.shouldKill("while_awaiting_approval", step, gen)) return void this.fire(gen);
      const [surface, answerToken] = Object.entries(issued.answerTokens)[0] ?? [];
      if (surface === undefined || answerToken === undefined) return;
      gen.broker
        .answer({
          approvalId: issued.approval.id,
          answerToken,
          decision: "approve",
          scope: "once",
          decidedBy: { deviceId: "dev_owner", surface },
        })
        .catch((e: unknown) => this.notes.push(`answer failed: ${String(e)}`));
    });
  }

  boot(index: number): Generation {
    const gen = bootGeneration({
      file: this.file,
      index,
      clock: this.clock,
      threads: {
        load: async (id) => structuredClone(this.threads.get(id)) as never,
        save: async (id, state) => void this.threads.set(id, structuredClone(state)),
      },
      threadId: THREAD,
      leaseMs: LEASE_MS,
      policy: this.o.policy ?? DEFAULT_POLICY,
      provider: (g) => ({
        id: "resumability",
        stream: (request, options) => this.stream(g, request, options),
        embed: (texts, options) => this.model.embed(texts, options),
        capabilities: (model) => this.model.capabilities(model),
      }),
      tools: this.tools.map((t) => ({
        name: t.name,
        spec: {
          name: t.name,
          description: `${t.name} (resumability harness)`,
          inputSchema: { type: "object" },
          sideEffect: t.sideEffect,
          provenanceOut: "trusted",
        },
        ...(t.describe === undefined
          ? {}
          : { describe: (p: unknown) => t.describe?.(p as Record<string, unknown>) ?? {} }),
        run: (g, params, ctx) => this.dispatch(g, t, params, ctx),
      })),
      onIssued: (g, issued) => this.onIssued(g, issued),
      recordReceipt: (g, real, input) => this.recordReceipt(g, real, input),
      ...(this.o.faults?.isReplaySafe === undefined
        ? {}
        : { isReplaySafe: this.o.faults.isReplaySafe }),
    });
    this.gens.push(gen);
    return gen;
  }

  /** Gateway boot after a crash: re-issue approvals, recover leases, reconcile with the provider. */
  async recover(gen: Generation, taskId: string): Promise<void> {
    const issued = await gen.broker.reissue();
    for (const i of issued) this.issuedIn.set(i.approval.id, gen.index);
    await gen.engine.recoverExpired();
    await gen.pool.onApprovalsReissued(issued);
    // The owner sees every re-issued card and answers it: a parked task resumes on it, and a
    // turn that was waiting in-process when it died picks it up when it asks again (#64).
    for (const i of issued) this.onIssued(gen, i);
    for (const cp of await gen.engine.checkpoints(taskId)) {
      if (cp.status !== "uncertain") continue;
      const effect = this.ledger.byCallId(cp.stepId);
      if (this.o.faults?.reconcile === "replay" || effect === undefined) {
        await gen.engine.reconcile(taskId, cp.stepId, {
          status: "failed",
          note: "the provider shows nothing",
        });
        this.reconciled.push({ stepId: cp.stepId, status: "failed" });
        continue;
      }
      const receipts = await gen.broker.listReceipts({ toolCallId: cp.stepId });
      const receipt =
        receipts.find((r) => r.outcome === "ok") ??
        (await gen.broker.recordReceipt({
          kind: effect.tool,
          outcome: "ok",
          summary: `Reconciled with the provider: ${effect.providerId}`,
          taskId,
          toolCallId: cp.stepId,
          approvalId: effect.approvalId,
          externalRefs: { providerId: effect.providerId },
          payload: { reconciled: true },
        }));
      await gen.engine.reconcile(taskId, cp.stepId, {
        status: "done",
        receiptId: receipt.id,
        note: `the provider has ${effect.providerId}`,
      });
      this.reconciled.push({ stepId: cp.stepId, status: "done" });
    }
  }

  /** Runs turns until nothing is claimable; `killed` when the process died mid-turn. */
  async drive(gen: Generation): Promise<"killed" | "settled" | "stuck"> {
    const killed = this.fired ? never<"killed">() : this.killed.then(() => "killed" as const);
    for (let i = 0; i < MAX_TURNS; i += 1) {
      const turn = gen.pool.runOnce();
      turn.catch(() => undefined);
      const r = await Promise.race([turn, killed]);
      if (r === "killed") return "killed";
      if (r === undefined) return "settled";
    }
    return "stuck";
  }
}

/** Runs `script` on the real stack, SIGKILLs the Gateway at `killAt`, restarts and checks. */
export async function runWithKill(options: RunWithKillOptions): Promise<RunReport> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-resume-")));
  const run = new Run(options, options.killAt, join(dir, "psyche.sqlite"));
  const startSeq = (peekCaptures().at(-1)?.seq ?? -1) + 1;
  registerSecret(run.ledger.credential, "provider-token");
  try {
    let gen = run.boot(0);
    const task = await gen.engine.create({
      threadId: THREAD,
      title: options.script.title,
      goal: options.script.goal,
      createdFrom: "chat",
    });
    let end = await run.drive(gen);
    if (end === "killed") {
      run.clock.advance(LEASE_MS + 1);
      gen = run.boot(1);
      await run.recover(gen, task.id);
      end = await run.drive(gen);
    }
    const report = await collect(run, gen, task.id, options);
    if (end !== "settled") report.violations.push({ code: "stuck", message: `run ended ${end}` });
    const leaks = scanCaptures(peekCaptures().filter((c) => c.seq >= startSeq));
    for (const l of leaks)
      report.violations.push({ code: "secret_leak", message: describeLeak(l) });
    return report;
  } finally {
    unregisterSecret(run.ledger.credential);
    for (const g of run.gens) g.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function collect(
  run: Run,
  gen: Generation,
  taskId: string,
  options: RunWithKillOptions,
): Promise<RunReport> {
  const task = await gen.engine.get(taskId);
  const checkpoints = await gen.engine.checkpoints(taskId);
  const actions = await gen.engine.actions(taskId);
  const receipts = await gen.broker.listReceipts({ taskId });
  const approvals = (await gen.broker.list()).map((a) => ({
    ...a,
    generation: run.issuedIn.get(a.id) ?? -1,
  }));
  const messages = ((run.threads.get(THREAD) as { messages?: ModelMessage[] })?.messages ??
    []) as ModelMessage[];
  captureModelVisible("receipt", receipts, { where: "resumability receipts" });
  captureModelVisible("transcript", messages, { where: "resumability transcript" });
  captureModelVisible("log", actions, { where: "resumability activity" });

  const { unsafe } = run;
  const kill = options.killAt ?? null;
  const killStep = kill === null ? "" : kill.slice(kill.indexOf(":") + 1);
  const killTool = options.script.steps.find((s) => s.id === killStep);
  const safeKill = killTool !== undefined && isCall(killTool) && !unsafe.has(killTool.tool);
  const report: RunReport = {
    killPoint: kill,
    outcome: outcomeOf(run, kill, approvals),
    expected: expectedFor(kill, safeKill, options.crash === "instant"),
    violations: checkInvariants({
      ledger: run.ledger.effects,
      receipts,
      checkpoints,
      actions,
      messages,
      approvals,
      task,
      dispatches: run.dispatches,
      unsafe,
      script: options.script,
      expectStatus: options.expectStatus ?? ["done"],
    }),
    generations: run.gens.length,
    task,
    ledger: run.ledger.effects,
    receipts,
    checkpoints,
    approvals,
    dispatches: run.dispatches,
    reconciled: run.reconciled,
    notes: run.notes,
  };
  if (!report.expected.includes(report.outcome) && report.outcome !== "not_reached") {
    report.violations.push({
      code: "unexpected_outcome",
      message: `${kill}: ${report.outcome}, expected ${report.expected.join(" | ")}`,
    });
  }
  return report;
}

function outcomeOf(
  run: Run,
  kill: KillPoint | null,
  approvals: { invalidatedReason?: string }[],
): Outcome {
  if (kill === null) return "no_kill";
  if (!run.fired) return "not_reached";
  if (approvals.some((a) => a.invalidatedReason === "gateway_restart")) return "reissues_approval";
  if (run.reconciled.length > 0) return "reconciles_uncertain";
  const safe = run.dispatches.filter((d) => !run.unsafe.has(d.tool));
  if (new Set(safe.map((d) => d.step)).size < safe.length) return "replays_safe_read";
  return "resumes";
}

/** The invariants every kill must leave intact (docs/03 Resumability, docs/05 §3.7, §3.11). */
export function checkInvariants(s: {
  ledger: LedgerEffect[];
  receipts: Receipt[];
  checkpoints: TaskCheckpoint[];
  actions: TaskAction[];
  messages: ModelMessage[];
  approvals: (ApprovalRequest & { generation: number })[];
  task: Task | undefined;
  dispatches: RunReport["dispatches"];
  unsafe: Set<string>;
  script: ResumabilityScript;
  expectStatus: Task["status"][];
}): Violation[] {
  const v: Violation[] = [];
  const add = (code: ViolationCode, message: string) => v.push({ code, message });
  const ok = s.receipts.filter((r) => r.outcome === "ok");
  const receiptsFor = (callId: string) => ok.filter((r) => r.toolCallId === callId);
  const byStep = new Map<string, LedgerEffect[]>();
  for (const e of s.ledger) byStep.set(e.step, [...(byStep.get(e.step) ?? []), e]);
  for (const [step, effects] of byStep) {
    if (effects.length > 1) {
      add("duplicate_effect", `${step}: ${effects.map((e) => e.providerId).join(", ")}`);
    }
  }
  const seen = new Set<string>();
  for (const d of s.dispatches) {
    if (s.unsafe.has(d.tool) && seen.has(d.callId)) add("replayed_dispatch", d.callId);
    seen.add(d.callId);
  }
  for (const e of s.ledger) {
    const n = receiptsFor(e.callId).length;
    if (n === 0) add("effect_without_receipt", `${e.providerId} (${e.callId})`);
    if (n > 1) add("duplicate_receipt", `${e.callId}: ${n} receipts`);
    const cp = s.checkpoints.find((c) => c.stepId === e.callId);
    if (cp?.status === "failed") add("reconciled_wrong", `${e.callId} is failed but was applied`);
    const approval = s.approvals.find((a) => a.id === e.approvalId);
    if (e.approvalId !== null && approval?.generation !== e.generation) {
      add("stale_approval", `${e.callId} used ${e.approvalId} from another boot`);
    }
  }
  const callTool = new Map<string, string>();
  for (const m of s.messages) {
    for (const p of m.parts) if (p.type === "tool_call") callTool.set(p.id, p.name);
  }
  for (const r of ok) {
    const d = s.dispatches.find((x) => x.callId === r.toolCallId && s.unsafe.has(x.tool));
    if (d !== undefined && s.ledger.every((e) => e.callId !== d.callId)) {
      add("receipt_without_effect", `${r.id} (${d.callId})`);
    }
  }
  for (const cp of s.checkpoints) {
    if (cp.status === "uncertain") add("unreconciled_uncertain", cp.stepId);
  }
  if (s.task === undefined || !s.expectStatus.includes(s.task.status)) {
    add("task_state", `task is ${s.task?.status ?? "missing"}`);
  }
  for (const step of s.script.steps) {
    if (isCall(step) || s.task?.status !== "done") continue;
    for (const claimed of step.claims ?? []) {
      const effect = byStep.get(claimed)?.[0];
      if (effect === undefined || receiptsFor(effect.callId).length === 0) {
        add("claim_without_receipt", `the answer claims ${claimed}`);
      }
    }
  }
  // A transcript tool result or an Activity line that says an unsafe call worked needs a receipt.
  const claimed = [
    ...s.messages
      .flatMap((m) => m.parts)
      .flatMap((p) =>
        p.type === "tool_result" && p.isError !== true ? [[p.callId, callTool.get(p.callId)]] : [],
      ),
    ...s.actions.flatMap((a) => (a.level2.outcome === "ok" ? [[a.toolCallId, a.level2.tool]] : [])),
  ];
  for (const [callId, tool] of claimed) {
    if (callId && tool && s.unsafe.has(tool) && receiptsFor(callId).length === 0) {
      add("transcript_without_receipt", `${tool} ${callId} shows as done without a receipt`);
    }
  }
  const lastGen = Math.max(0, ...s.approvals.map((a) => a.generation));
  for (const a of s.approvals) {
    if (a.status === "pending" && a.generation < lastGen) {
      add("stale_pending_approval", `${a.id} from boot ${a.generation} is still pending`);
    }
  }
  return v;
}

export interface KillPointResult {
  killPoint: KillPoint;
  outcome: Outcome;
  violations: Violation[];
}

/** Every kill point of `script` (or a seeded random `sample` of them), one run each. */
export async function exploreKillPoints(
  options: ResumabilityOptions & { sample?: number; seed?: number },
): Promise<KillPointResult[]> {
  let points = enumerateKillPoints(options.script, options.tools);
  if (options.sample !== undefined && options.sample < points.length) {
    let a = (options.seed ?? 1) >>> 0;
    const random = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const keyed = points.map((p, i) => ({ p, i, k: random() }));
    keyed.sort((x, y) => x.k - y.k);
    const picked = new Set(keyed.slice(0, options.sample).map((x) => x.i));
    points = points.filter((_, i) => picked.has(i));
  }
  const results: KillPointResult[] = [];
  for (const killPoint of points) {
    const r = await runWithKill({ ...options, killAt: killPoint });
    results.push({ killPoint, outcome: r.outcome, violations: r.violations });
  }
  return results;
}
