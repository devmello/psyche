// Real packages are imported by relative path on purpose: they list @psyche/testing as a
// devDependency, so declaring them in package.json would make a workspace cycle turbo rejects.

import type {
  AgentEvent,
  ApprovalAnswerInput,
  ApprovalRequestInput,
  ApprovalStatus,
  DecisionContext,
  DeviceScope,
  GrantFilter,
  IssuedApproval,
  ModelEvent,
  ModelProvider,
  PermissionBroker,
  PermissionMode,
  ReceiptInput,
  ToolCall,
  ToolCallIntent,
} from "@psyche/protocol";
import {
  type AgentToolRegistration,
  createAgentLoop,
  InMemoryThreadStateStore,
  type PsycheAgentLoop,
} from "../../../agent-core/src/index.ts";
import { createAuditLog, type HashChainAuditLog, Receipts } from "../../../audit/src/index.ts";
import {
  createPermissionBroker,
  MemoryPermissionStore,
  type PolicyCall,
  type PolicyContext,
  type PsychePermissionBroker,
} from "../../../permissions/src/index.ts";
import { FakeClock } from "../clock.ts";
import { FakeModelProvider } from "../fakes/FakeModelProvider.ts";
import { FakeNotifier } from "../fakes/FakeNotifier.ts";
import { createIdGenerator } from "../ids.ts";
import type { Json, ScriptCall, ScriptTurn } from "./types.ts";
import {
  connectorOf,
  type Fixtures,
  type ToolImpl,
  type ToolInfo,
  type ToolRun,
  World,
} from "./world.ts";

/** Services agent-core's built-in tools need (`task.start`, `schedule`, `notify`, `memory`). */
export type BuiltinServices = Pick<
  Parameters<typeof createAgentLoop>[0],
  "tasks" | "scheduler" | "notifier" | "memory"
>;

export interface StackOverrides {
  /** Wrap a fake connector executor (inside the broker and binding checks). */
  wrapTool?: (name: string, run: ToolRun) => ToolRun;
  /** Replace the broker the agent loop sees, e.g. a broken one in a negative test. */
  wrapBroker?: (broker: PermissionBroker) => PermissionBroker;
  /**
   * Live mode (INT-3, tests/acceptance/live): a real provider instead of the scenario script.
   * The loop runs `model` on it; script turns and script-divergence checks do not apply.
   */
  provider?: { provider: ModelProvider; model: string };
  /**
   * Extra fake executors by tool name, merged over the World's own (INT-3's Milestone 2
   * scenarios: documents, messages, speech, goals). Called once, so their state survives a
   * restart; a tool still needs a row in the scenario's tool registry to be registered.
   */
  impls?: (world: World, stack: Stack) => Record<string, ToolImpl>;
  /** Services for agent-core's built-in tools; without them those tools are not offered. */
  services?: (stack: Stack) => BuiltinServices;
  /**
   * Real tool registrations (the V10 coding tools over a fixture repository), registered as
   * they are, with their own `describeCall`; called once, so they survive a restart. A tool
   * still needs a row in the scenario's tool registry for the validator and the assertions.
   */
  registrations?: (stack: Stack) => AgentToolRegistration[];
}

export interface RunRec {
  runId: string;
  taskId: string;
  /** The thread the run is on: the scenario's, or an isolated automation session's. */
  thread: string;
  mode: "attended" | "unattended";
  step: string;
  text: string;
  gen: number;
  status: string;
  ended: boolean;
  outcome?: string;
}

export interface CallRec {
  id: string;
  tool: string;
  args: Json;
  step: string;
  runId: string;
  record?: ToolCall;
}

const usage: ModelEvent = {
  type: "usage",
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
};

/** A script turn as `FakeModelProvider` events. */
export function turnEvents(turn: ScriptTurn): ModelEvent[] {
  if (turn.toolCalls !== undefined && turn.toolCalls.length > 0) {
    return [
      ...turn.toolCalls.map(
        (c): ModelEvent => ({ type: "tool_call", id: c.id, name: c.tool, input: c.args }),
      ),
      usage,
      { type: "finish", reason: "tool_calls" },
    ];
  }
  return [{ type: "text_delta", text: turn.text ?? "" }, usage, { type: "finish", reason: "stop" }];
}

/**
 * The Gateway's side of the broker seam: adds what the loop's intent cannot carry (connector
 * matrix key, taint sources), remembers issued cards, and re-attaches a resumed call to the card
 * `reissue()` issued for it after a restart (security §3.7 "Restart").
 */
class GatewayBroker implements PermissionBroker {
  readonly adoptable: IssuedApproval[] = [];
  readonly inner: PsychePermissionBroker;
  readonly s: Stack;

  constructor(inner: PsychePermissionBroker, s: Stack) {
    this.inner = inner;
    this.s = s;
  }

  /**
   * The world's taint sources for a thread (sender or origin of each untrusted result), ahead of
   * the loop's own coarser `{tool, target}` entries: what the owner should see on a card.
   */
  #context(ctx: DecisionContext): PolicyContext {
    const world = this.s.ledger
      .filter((l) => l.thread === ctx.threadId)
      .flatMap((l) => l.sources)
      .map((src) => {
        const [kind, ...rest] = src.split(":");
        const v = rest.join(":");
        return kind === "web"
          ? { sourceKind: "web", origin: v }
          : { sourceKind: kind ?? "", sender: v };
      });
    const taintSources = [...world, ...(ctx.taintSources ?? [])];
    return { ...ctx, ...(taintSources.length > 0 ? { taintSources } : {}) };
  }

  decide(call: ToolCallIntent, ctx: DecisionContext) {
    const connector = connectorOf(this.s.toolInfo.get(call.tool));
    const pc: PolicyCall = { ...call, ...(connector === undefined ? {} : { meta: { connector } }) };
    return this.inner.decide(pc, this.#context(ctx));
  }

  /** Dry run with the same enrichment as `decide`, so the preview sees what the decision sees. */
  preview(intents: ToolCallIntent[], ctx: DecisionContext) {
    const calls = intents.map((call): PolicyCall => {
      const connector = connectorOf(this.s.toolInfo.get(call.tool));
      return { ...call, ...(connector === undefined ? {} : { meta: { connector } }) };
    });
    return this.inner.preview(calls, this.#context(ctx));
  }

  async requestApproval(raw: ApprovalRequestInput): Promise<IssuedApproval> {
    const input: ApprovalRequestInput =
      raw.context === undefined ? raw : { ...raw, context: this.#context(raw.context) };
    const i = this.adoptable.findIndex(
      (a) =>
        a.approval.bindingHash === input.bindingHash &&
        a.approval.requestedBy.toolCallId === input.requestedBy.toolCallId,
    );
    const issued =
      i >= 0
        ? (this.adoptable.splice(i, 1)[0] as IssuedApproval)
        : await this.inner.requestApproval(input);
    this.s.noteIssued(issued, input.requestedBy.runId ?? "");
    return issued;
  }

  answer = (i: ApprovalAnswerInput) => this.inner.answer(i);
  awaitDecision = (id: string, signal?: AbortSignal) => this.inner.awaitDecision(id, signal);
  verifyBinding = (id: string, hash: string) => this.inner.verifyBinding(id, hash);
  get = (id: string) => this.inner.get(id);
  list = (f?: { status?: ApprovalStatus }) => this.inner.list(f);
  reissue = () => this.inner.reissue();
  recordReceipt = (i: ReceiptInput) => this.inner.recordReceipt(i);
  listReceipts = (f?: { taskId?: string; toolCallId?: string }) => this.inner.listReceipts(f);
  revokeRunAuthority = (runId: string) => this.inner.revokeRunAuthority(runId);
  listGrants = (f?: GrantFilter) => this.inner.listGrants(f);
  revokeGrant = (id: string) => this.inner.revokeGrant(id);
}

/** Real agent loop + real Permission Broker + real audit chain over the scenario fakes. */
export class Stack {
  readonly clock: FakeClock;
  readonly ids = createIdGenerator();
  readonly audit: HashChainAuditLog;
  readonly notifier: FakeNotifier;
  readonly broker: PsychePermissionBroker;
  readonly gateway: GatewayBroker;
  readonly loopBroker: PermissionBroker;
  readonly world: World;
  readonly model = new FakeModelProvider({ id: "fake" });
  readonly toolInfo: Map<string, ToolInfo>;
  readonly runs: RunRec[] = [];
  readonly calls = new Map<string, CallRec>();
  readonly scriptCalls = new Map<string, ScriptCall>();
  readonly events: { step: string; event: AgentEvent }[] = [];
  readonly texts: { step: string; text: string }[] = [];
  readonly ledger: { step: string; thread: string; callId: string; sources: string[] }[] = [];
  readonly issued = new Map<string, IssuedApproval>();
  readonly approvalStep = new Map<string, string>();
  readonly approvalRun = new Map<string, string>();
  readonly reissueOf = new Map<string, string>();
  readonly status = new Map<string, ApprovalStatus>();
  readonly divergences: string[] = [];
  readonly reqSteps: string[] = [];
  readonly receiptStep = new Map<string, string>();
  secretRefs: string[] = [];
  gen = 0;
  step = "";
  loop!: PsycheAgentLoop;
  #state = new InMemoryThreadStateStore();
  #extra: Record<string, ToolImpl> = {};
  #services: BuiltinServices = {};
  #registrations: AgentToolRegistration[] = [];

  readonly thread: string;
  readonly mode: PermissionMode;
  readonly overrides: StackOverrides;

  constructor(
    fx: Fixtures,
    tools: ToolInfo[],
    thread: string,
    mode: PermissionMode,
    clockStart: string,
    overrides: StackOverrides = {},
  ) {
    this.thread = thread;
    this.mode = mode;
    this.overrides = overrides;
    this.clock = new FakeClock(Date.parse(clockStart));
    this.toolInfo = new Map(tools.map((t) => [t.name, t]));
    this.audit = createAuditLog({ clock: this.clock });
    this.notifier = new FakeNotifier({ clock: this.clock, ids: this.ids });
    const perms = fx.owner.permissions as Json;
    const devices = fx.owner.devices as { id: string; scopes: DeviceScope[] }[];
    const store = new MemoryPermissionStore();
    for (const g of (perms.standingGrants as Json[] | undefined) ?? []) {
      const origin = String((g.subject as Json).origin);
      for (const t of tools.filter((x) => x.approvalKind === g.kind)) {
        const grantKey = `${t.name}|${origin}`;
        const target = { kind: "origin" as const, value: origin };
        store.insertGrant({
          grant: {
            id: `${g.id}_${t.name}`,
            kind: t.approvalKind as NonNullable<ToolInfo["approvalKind"]>,
            scope: g.scope as "site",
            grantKey,
            subject: { grantKey, target, sideEffect: t.sideEffect },
            binding: null,
            expiresAt: String(g.expiresAt),
            useCount: Number(g.uses ?? 0),
            lastUsedAt: null,
            createdFromApprovalId: null,
            taskId: null,
            createdAt: String(g.createdAt),
            revokedAt: null,
          },
          meta: {
            sideEffect: t.sideEffect,
            sessionId: null,
            threadId: null,
            origin,
            createdByDeviceId: devices[0]?.id ?? null,
            maxUses: null,
            lastUsedBindingHash: null,
            revokedReason: null,
          },
        });
      }
    }
    this.broker = createPermissionBroker({
      approvers: {
        device: async (id) => devices.find((d) => d.id === id),
        isOwnerSender: async () => false,
      },
      store,
      audit: this.audit,
      receipts: new Receipts({
        clock: this.clock,
        audit: this.audit,
        newId: () => this.ids.next("rcp"),
      }),
      notifier: this.notifier,
      clock: this.clock,
      policy: {
        defaultMode: perms.defaultMode as PermissionMode,
        approvals: { ttlMinutes: Number((perms.approvals as Json).ttlMinutes) },
        connectors: perms.connectors as Record<string, Record<string, "allow" | "ask" | "deny">>,
      },
      // The scenario clock is frozen between steps; the 400 ms arm delay is not under test here.
      armDelayMs: 0,
      newId: (prefix) => this.ids.next(prefix),
    });
    this.broker.subscribe((e) => {
      if ("approval" in e) this.status.set(e.approval.id, e.approval.status);
      if (e.type === "receipt.created") this.receiptStep.set(e.receipt.id, this.step);
    });
    this.gateway = new GatewayBroker(this.broker, this);
    this.loopBroker = overrides.wrapBroker?.(this.gateway) ?? this.gateway;
    this.world = new World(fx, this.clock, this.notifier, () => this.loopBroker, this.audit);
    this.#extra = overrides.impls?.(this.world, this) ?? {};
    this.#services = overrides.services?.(this) ?? {};
    // Dispatches are recorded as for the World's fakes (`tool_called.dispatched`).
    this.#registrations = (overrides.registrations?.(this) ?? []).map((r) => {
      const inner = r.run;
      if (inner === undefined) return r;
      return {
        ...r,
        run: (params, ctx) => {
          this.world.dispatched.add(ctx.callId);
          return inner(params, ctx);
        },
      };
    });
    this.#boot();
  }

  /** Start a Gateway generation: a fresh agent loop over the persisted thread state. */
  #boot(): void {
    const gen = this.gen;
    const live = this.overrides.provider;
    const upstream: ModelProvider = live?.provider ?? this.model;
    const provider: ModelProvider = {
      id: upstream.id,
      capabilities: (m) => upstream.capabilities(m),
      stream: (req, opts) => this.#stream(gen, req, opts),
    };
    this.loop = createAgentLoop({
      ...this.#services,
      provider,
      model: live?.model ?? "fake/main",
      broker: this.loopBroker,
      state: this.#state,
      clock: this.clock,
      ids: this.ids,
      timeZone: this.world.tz,
      hooks: {
        // A live model's arguments are known only to the loop until the call's final event
        // (details travel with it); a parked call must be replayable before that.
        before_tool_call: ({ toolCallId, tool, params, runId }) => {
          if (gen !== this.gen) return undefined;
          const c = this.calls.get(toolCallId);
          const args = structuredClone(params) as Json;
          if (c === undefined) {
            this.calls.set(toolCallId, { id: toolCallId, tool, args, step: this.step, runId });
          } else if (
            Object.keys(c.args).length === 0 &&
            args !== null &&
            typeof args === "object"
          ) {
            c.args = args;
          }
          return undefined;
        },
        tool_result_persist: ({ record }) => {
          if (gen !== this.gen) return;
          const c = this.calls.get(record.id);
          if (c !== undefined) c.record = record;
          const sources = this.world.sources.get(record.id);
          if (record.taintOut && sources !== undefined)
            this.ledger.push({
              step: this.step,
              thread: this.runs.find((r) => r.runId === record.runId)?.thread ?? this.thread,
              callId: record.id,
              sources,
            });
        },
      },
    });
    for (const t of this.world.tools(
      [...this.toolInfo.values()],
      this.overrides.wrapTool,
      this.#extra,
    ))
      this.loop.registry.register(t);
    for (const t of this.#registrations) this.loop.registry.register(t);
  }

  async *#stream(
    gen: number,
    req: Parameters<ModelProvider["stream"]>[0],
    opts?: Parameters<ModelProvider["stream"]>[1],
  ) {
    if (gen !== this.gen) {
      yield { type: "finish", reason: "error", error: "gateway stopped" } as ModelEvent;
      return;
    }
    const live = this.overrides.provider;
    if (live !== undefined) {
      this.reqSteps.push(this.step);
      yield* live.provider.stream(req, opts);
      return;
    }
    if (this.model.remainingTurns === 0) {
      this.divergences.push(
        `${this.step}: the model was asked for a turn the script does not have`,
      );
      yield { type: "finish", reason: "error", error: "script exhausted" } as ModelEvent;
      return;
    }
    this.reqSteps.push(this.step);
    yield* this.model.stream(req, opts);
  }

  enqueue(turns: ScriptTurn[]): void {
    for (const t of turns) {
      for (const c of t.toolCalls ?? []) this.scriptCalls.set(c.id, c);
      this.model.enqueue(turnEvents(t));
    }
  }

  noteIssued(issued: IssuedApproval, runId: string): void {
    const id = issued.approval.id;
    this.issued.set(id, issued);
    this.status.set(id, issued.approval.status);
    if (!this.approvalStep.has(id)) this.approvalStep.set(id, this.step);
    this.approvalRun.set(id, runId);
  }

  /** `unattended`: an automation or background run (no one is there to answer a card). */
  startRun(
    text: string,
    taskId: string,
    runId = `run_${this.step}`,
    mode: "attended" | "unattended" = "attended",
    /** Another thread (an automation's isolated session); default the scenario's. */
    thread: string = this.thread,
  ): RunRec {
    const rec: RunRec = {
      runId,
      taskId,
      thread,
      mode,
      step: this.step,
      text,
      gen: this.gen,
      status: "running",
      ended: false,
    };
    this.runs.push(rec);
    const loop = this.loop;
    void (async () => {
      const turn = loop.startTurn({
        threadId: thread,
        runId,
        taskId,
        input: { text },
        mode,
        permissionMode: this.mode,
      });
      for await (const e of turn) {
        if (rec.gen !== this.gen) continue;
        this.events.push({ step: this.step, event: e });
        if (e.type === "run.status") rec.status = e.status;
        // The loop may wait on a card the restart re-issued without asking for a new one (#64).
        if (e.type === "approval_requested") this.approvalRun.set(e.approval.id, runId);
        if (e.type === "chat.delta") this.texts.push({ step: this.step, text: e.delta });
        if (e.type === "tool_call" && e.status === "pending" && !this.calls.has(e.toolCallId)) {
          const sc = this.scriptCalls.get(e.toolCallId);
          this.calls.set(e.toolCallId, {
            id: e.toolCallId,
            tool: e.tool,
            // Scripted calls carry their arguments; a live model's come with the first event.
            args: (sc?.args ?? e.details?.paramsRedacted ?? {}) as Json,
            step: this.step,
            runId,
          });
        }
        if (e.type === "end") {
          rec.ended = true;
          rec.outcome = e.outcome;
        }
      }
    })();
    return rec;
  }

  pendingOf(run: RunRec): string[] {
    return [...this.approvalRun]
      .filter(([id, r]) => r === run.runId && this.status.get(id) === "pending")
      .map(([id]) => id);
  }

  /** Let every live run progress until it ends or parks on a pending approval. */
  async settle(): Promise<void> {
    let idle = 0;
    for (let i = 0; i < 100_000; i += 1) {
      await new Promise<void>((r) => setImmediate(r));
      const busy = this.runs.some(
        (r) =>
          r.gen === this.gen &&
          !r.ended &&
          !(r.status === "awaiting_approval" && this.pendingOf(r).length > 0),
      );
      idle = busy ? 0 : idle + 1;
      if (idle >= 3) return;
    }
    throw new Error(`${this.step}: the run did not settle`);
  }

  /**
   * Simulated Gateway kill and restart on the same state: the old loop is cut off from the model,
   * `reissue()` invalidates and re-issues pending cards, and a new loop resumes each parked run
   * by replaying its persisted tool call (the replay is not a model event).
   */
  async restart(): Promise<void> {
    const parked = this.runs.filter((r) => r.gen === this.gen && !r.ended);
    const pending = new Map(parked.map((r) => [r, this.pendingOf(r)]));
    // What the dead Gateway had persisted; its runs keep writing to their own (old) store.
    const threads = [...new Set([this.thread, ...this.runs.map((r) => r.thread)])];
    const persisted = await Promise.all(threads.map((t) => this.#state.load(t)));
    this.#state = new InMemoryThreadStateStore();
    for (const [i, t] of threads.entries()) {
      const state = persisted[i];
      if (state !== undefined) await this.#state.save(t, state);
    }
    this.gen += 1;
    const old = await this.broker.list();
    for (const issued of await this.gateway.reissue()) {
      const a = issued.approval;
      const prev = old.find(
        (o) =>
          o.status === "pending" &&
          o.bindingHash === a.bindingHash &&
          o.requestedBy.toolCallId === a.requestedBy.toolCallId,
      );
      if (prev !== undefined) this.reissueOf.set(a.id, prev.id);
      this.issued.set(a.id, issued);
      this.status.set(a.id, a.status);
      this.approvalStep.set(a.id, this.step);
      this.gateway.adoptable.push(issued);
    }
    this.#boot();
    for (const [run, ids] of pending) {
      const replay = ids
        .map((id) => this.issued.get(id)?.approval.requestedBy.toolCallId)
        .map((callId) => (callId === undefined ? undefined : this.scriptCalls.get(callId)))
        .filter((c): c is ScriptCall => c !== undefined);
      if (replay.length === 0) continue;
      if (this.model.remainingTurns > 0)
        this.divergences.push(`${this.step}: script turns left at restart`);
      this.model.enqueue(turnEvents({ toolCalls: replay }));
      const saved = this.step;
      this.step = run.step;
      const rec = this.startRun(run.text, run.taskId, `${run.runId}_resumed`, run.mode, run.thread);
      this.step = saved;
      rec.step = run.step;
    }
  }
}
