import type {
  ContextLimits,
  ContextUsage,
  EffectiveContextLimits,
  EndpointProbe,
  ModelProviderSummary,
  ModelRoles,
} from "@psyche/protocol";
import {
  type ApprovalRequest,
  type Artifact,
  type Automation,
  type BotAuthStatus,
  type Channel,
  type ChannelIdentity,
  type Connector,
  type CredentialMeta,
  type CredentialUse,
  type Device,
  type ErrorCode,
  type EventName,
  type EventPayload,
  type FeedPost,
  FILE_CHUNK_BYTES,
  type Goal,
  type GoalMilestone,
  type Grant,
  type Idea,
  type InputRequest,
  type LibraryItem,
  type LinkPaymentMethod,
  type MemoryChunk,
  type MemoryClaim,
  type Message,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type NodeInfo,
  type Notification,
  type PairingRequest,
  PsycheError,
  type Receipt,
  type Run,
  requiresIdempotencyKey,
  type SearchHit,
  type SkillDetails,
  type SkillProposal,
  type Task,
  type TaskAction,
  type ThreadListEntry,
  type ToolCall,
  type VaultPayment,
  validateEventPayload,
  validateParams,
  validateResult,
} from "@psyche/protocol";
import type { MockFileNode } from "../fixtures/files.ts";
import type { MockSkillSource } from "../fixtures/skills.ts";
import type { ConnectionState, GatewayClient, GatewayEvent, RequestOptions } from "./client.ts";
import { toBase64 } from "./files.ts";

/**
 * In-memory Gateway for stories and tests (no network). It speaks the protocol exactly: every
 * request's params, every result and every event payload is validated against the registry in
 * `@psyche/protocol`, side-effecting methods require an idempotency key, and events carry
 * increasing `seq` and `stateVersion`. Helpers script streaming replies, approvals, gaps and
 * disconnects.
 */

export interface MockWorld {
  threads: ThreadListEntry[];
  messages: Message[];
  runs: Run[];
  toolCalls: ToolCall[];
  tasks: Task[];
  taskActions: TaskAction[];
  approvals: ApprovalRequest[];
  answerTokens: Record<string, string>;
  inputRequests: InputRequest[];
  receipts: Receipt[];
  artifacts: Artifact[];
  library: LibraryItem[];
  files: Record<string, MockFileNode>;
  notifications: Notification[];
  feed: FeedPost[];
  nextBriefAt: string | null;
  ideas: Idea[];
  goals: Goal[];
  automations: Automation[];
  grants: Grant[];
  connectors: Connector[];
  channels: Channel[];
  pairingRequests: PairingRequest[];
  channelIdentities: ChannelIdentity[];
  devices: Device[];
  /** Web Bot Auth (I14). */
  botAuth: BotAuthStatus;
  nodes: NodeInfo[];
  credentials: CredentialMeta[];
  credentialUses: CredentialUse[];
  /** Stripe Link (`vault.payments.*`); absent → Link is not set up (`payments_not_configured`). */
  linkMethods?: LinkPaymentMethod[];
  payments?: VaultPayment[];
  settings: Record<string, unknown>;
  memoryFiles: Record<string, string>;
  memoryClaims: MemoryClaim[];
  searchHits: SearchHit[];
  skills: SkillDetails[];
  skillSources: Record<string, MockSkillSource>;
  /** `models.list` providers (B1, B4); absent → `models.list` answers with none. */
  modelProviders?: ModelProviderSummary[];
  modelRoles?: ModelRoles;
  /** What `models.probe` finds per provider id (recorded fixtures); missing → unreachable. */
  modelProbes?: Record<string, EndpointProbe>;
  /** The last turn's context usage by thread id (`threads.contextUsage`). */
  contextUsage?: Record<string, ContextUsage>;
  /** Each thread's own context limits (`threads.setContextLimits`). */
  contextLimits?: Record<string, ContextLimits>;
}

/** The model window the mock reports when a thread has no usage yet. */
export const MOCK_CONTEXT_WINDOW = 200_000;

export const EMPTY_WORLD: MockWorld = {
  threads: [],
  messages: [],
  runs: [],
  toolCalls: [],
  tasks: [],
  taskActions: [],
  approvals: [],
  answerTokens: {},
  inputRequests: [],
  receipts: [],
  artifacts: [],
  library: [],
  files: {},
  notifications: [],
  feed: [],
  nextBriefAt: null,
  ideas: [],
  goals: [],
  automations: [],
  grants: [],
  connectors: [],
  channels: [],
  pairingRequests: [],
  channelIdentities: [],
  devices: [],
  botAuth: {
    enabled: false,
    keyId: null,
    publicJwk: null,
    createdAt: null,
    signatureAgent: null,
    directoryPath: "/.well-known/http-message-signatures-directory",
    origins: [],
    advertised: [],
  },
  nodes: [],
  credentials: [],
  credentialUses: [],
  settings: {},
  memoryFiles: {},
  memoryClaims: [],
  searchHits: [],
  skills: [],
  skillSources: {},
};

export interface MockGatewayOptions {
  /** Delay before each response, in ms (0 = next microtask). */
  latency?: number;
  /** Clock for timestamps the mock creates. */
  now?: () => string;
  /** Initial connection state (default `open`). */
  connection?: ConnectionState;
}

export interface RecordedCall {
  method: string;
  params: unknown;
  idempotencyKey?: string;
}

type Handler = (params: never) => unknown;

const MOCK_MIME: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  pdf: "application/pdf",
  png: "image/png",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  eml: "message/rfc822",
};
const mockMime = (name: string): string =>
  MOCK_MIME[name.toLowerCase().split(".").pop() ?? ""] ?? "application/octet-stream";

const fail = (code: ErrorCode, message: string): never => {
  throw new PsycheError(code, message);
};

export class MockGateway implements GatewayClient {
  readonly world: MockWorld;
  readonly calls: RecordedCall[] = [];
  /** A host's presence (a web passkey); tests set it to exercise approvals that need one. */
  presence?: GatewayClient["presence"];
  private seq = 0;
  private stateVersion = 1;
  private state: ConnectionState;
  private listeners = new Set<(e: GatewayEvent) => void>();
  private connListeners = new Set<(s: ConnectionState) => void>();
  private idempotent = new Map<string, unknown>();
  private failures = new Map<string, { code: ErrorCode; message: string }>();
  private latency: number;
  private now: () => string;
  private counter = 0;
  private skillProposals = new Map<string, SkillProposal>();

  constructor(world: Partial<MockWorld> = {}, options: MockGatewayOptions = {}) {
    this.world = structuredClone({ ...EMPTY_WORLD, ...world });
    this.latency = options.latency ?? 0;
    this.now = options.now ?? (() => new Date().toISOString());
    this.state = options.connection ?? "open";
  }

  // --- GatewayClient ---------------------------------------------------------------------------

  async request<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    options: RequestOptions = {},
  ): Promise<MethodResult<M>> {
    this.calls.push({
      method,
      params,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    });
    await this.delay();
    if (this.state !== "open") fail("unavailable", "the Gateway is not reachable");
    const failure = this.failures.get(method);
    if (failure !== undefined) {
      this.failures.delete(method);
      fail(failure.code, failure.message);
    }
    const valid = validateParams(method, params);
    if (requiresIdempotencyKey(method)) {
      const key = options.idempotencyKey;
      if (key === undefined) fail("invalid_params", `${method} requires an idempotencyKey`);
      const cacheKey = `${method}:${key}`;
      if (this.idempotent.has(cacheKey)) return this.idempotent.get(cacheKey) as MethodResult<M>;
      const result = this.dispatch(method, valid);
      this.idempotent.set(cacheKey, result);
      return result;
    }
    return this.dispatch(method, valid);
  }

  subscribe(listener: (event: GatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connectionState(): ConnectionState {
    return this.state;
  }

  onConnectionState(listener: (state: ConnectionState) => void): () => void {
    this.connListeners.add(listener);
    return () => this.connListeners.delete(listener);
  }

  // --- Scripting -------------------------------------------------------------------------------

  /** Pushes a validated event to every subscriber. */
  emit<E extends EventName>(event: E, payload: EventPayload<E>): void {
    validateEventPayload(event, payload);
    this.seq += 1;
    this.stateVersion += 1;
    const frame = {
      event,
      payload,
      seq: this.seq,
      stateVersion: this.stateVersion,
    } as GatewayEvent;
    for (const l of this.listeners) l(frame);
  }

  /** Drops the next `n` events on the floor, so clients see a `seq` gap. */
  skipEvents(n = 1): void {
    this.seq += n;
    this.stateVersion += n;
  }

  setConnection(state: ConnectionState): void {
    this.state = state;
    for (const l of this.connListeners) l(state);
  }

  /** Makes the next call to `method` fail with `code`. */
  failNext(method: MethodName, code: ErrorCode, message = `${method} failed`): void {
    this.failures.set(method, { code, message });
  }

  /** Streams an agent reply as `chat.delta` chunks, then commits it with `chat.message`. */
  async streamReply(
    threadId: string,
    text: string,
    options: { chunk?: number; messageId?: string; runId?: string; interval?: number } = {},
  ): Promise<Message> {
    const messageId = options.messageId ?? this.id("msg");
    const chunk = options.chunk ?? 12;
    for (let i = 0; i < text.length; i += chunk) {
      this.emit("chat.delta", {
        threadId,
        messageId,
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        delta: text.slice(i, i + chunk),
      });
      if (options.interval !== undefined) await sleep(options.interval);
    }
    const message = this.commitMessage(threadId, "agent", [{ type: "text", md: text }], {
      id: messageId,
      runId: options.runId ?? null,
    });
    return message;
  }

  /** Adds a message to the world and emits `chat.message`. */
  commitMessage(
    threadId: string,
    role: Message["role"],
    blocks: Message["blocks"],
    extra: Partial<Message> = {},
  ): Message {
    const seq = this.world.messages
      .filter((m) => m.threadId === threadId)
      .reduce((max, m) => Math.max(max, m.seq), -1);
    const message: Message = {
      id: this.id("msg"),
      threadId,
      seq: seq + 1,
      role,
      blocks,
      providerNative: null,
      provenance: role === "user" ? "owner" : role === "system" ? "system" : "agent",
      replyToMessageId: null,
      channelRef: null,
      runId: null,
      createdAt: this.now(),
      ...extra,
    };
    this.world.messages = [...this.world.messages.filter((m) => m.id !== message.id), message];
    this.emit("chat.message", { message });
    return message;
  }

  /** `skills.propose*`: stages a proposal and opens its device-only `skill_install` card. */
  private stageSkill(src: MockSkillSource | undefined, missing: string) {
    if (src === undefined) return fail("not_found", missing);
    if ("violations" in src) {
      throw new PsycheError(
        "policy_denied",
        `the skill asks for more than the policy allows: ${src.violations.join("; ")}`,
        { details: { violations: src.violations } },
      );
    }
    const now = this.now();
    const proposal: SkillProposal = {
      ...src.proposal,
      id: this.id("skp"),
      bindingHash: `sha256:${"b".repeat(64)}`,
      grantKey: `sha256:${"c".repeat(64)}`,
      expiresAt: Date.parse(now) + 30 * 60_000,
    };
    this.skillProposals.set(proposal.id, proposal);
    const manifest = proposal.manifest ?? { tools: [], permissions: [], prompts: [] };
    const approval = this.requestApproval({
      id: this.id("apr"),
      kind: "skill_install",
      summary: `Install skill "${proposal.name}"`,
      details: {
        name: proposal.name,
        scope: proposal.scope,
        source: proposal.source,
        hash: proposal.hash,
        permissions: manifest.permissions,
        tools: manifest.tools,
        prompts: manifest.prompts,
        trust: proposal.trust,
        findings: {
          high: proposal.findings.filter((f) => f.severity === "high").length,
          warn: proposal.findings.filter((f) => f.severity === "warn").length,
          info: proposal.findings.filter((f) => f.severity === "info").length,
        },
        files: proposal.files.map((f) => f.path),
      },
      bindingHash: proposal.bindingHash,
      grantKey: proposal.grantKey,
      requestedBy: { runId: null, taskId: null, threadId: null },
      sideEffect: "destructive",
      surfaces: ["desktop", "web"],
      scopesOffered: ["once"],
      deviceOnly: true,
      requiresAuthentication: false,
      taint: false,
      status: "pending",
      scopeGranted: null,
      decidedBy: null,
      requestedAt: now,
      expiresAt: new Date(Date.parse(now) + 30 * 60_000).toISOString(),
      decidedAt: null,
      grantId: null,
    });
    return { proposal, approval };
  }

  /** Creates a pending approval, delivers it with this surface's token, and returns it. */
  requestApproval(approval: ApprovalRequest, answerToken = `at_${approval.id}`): ApprovalRequest {
    this.world.approvals = [...this.world.approvals.filter((a) => a.id !== approval.id), approval];
    this.world.answerTokens[approval.id] = answerToken;
    this.emit("approval.created", { approval, answerToken });
    return approval;
  }

  /** Sets a run's status and emits `run.updated`. */
  setRun(run: Run): void {
    this.world.runs = [...this.world.runs.filter((r) => r.id !== run.id), run];
    this.emit("run.updated", { run });
  }

  id(prefix: string): string {
    this.counter += 1;
    return `${prefix}_mock_${String(this.counter).padStart(4, "0")}`;
  }

  // --- Dispatch --------------------------------------------------------------------------------

  private dispatch<M extends MethodName>(method: M, params: MethodParams<M>): MethodResult<M> {
    const handler = (this.handlers as Partial<Record<string, Handler>>)[method];
    if (handler === undefined) fail("not_implemented", `MockGateway does not implement ${method}`);
    const result = (handler as Handler)(params as never);
    return validateResult(method, result) as MethodResult<M>;
  }

  /** The owner's Link payment methods; like the vault, `unavailable` when Link is not set up. */
  private linkWallet(): LinkPaymentMethod[] {
    if (this.world.linkMethods === undefined) {
      throw new PsycheError("unavailable", "Stripe Link is not set up", {
        details: { reason: "payments_not_configured" },
      });
    }
    return this.world.linkMethods;
  }

  private find<T extends { id: string }>(list: T[], id: string, what: string): T {
    return list.find((x) => x.id === id) ?? fail("not_found", `${what} ${id} not found`);
  }

  /** Like the Gateway: a path must lie in a folder `permissions.policy` grants. */
  private assertGranted(path: string): void {
    const policy = this.world.settings["permissions.policy"] as
      | { folders?: { path: string }[] }
      | undefined;
    const ok = (policy?.folders ?? []).some(
      (f) => path === f.path || path.startsWith(`${f.path}/`),
    );
    if (!ok) fail("forbidden", `${path} is outside every granted folder`);
  }

  private replace<K extends keyof MockWorld>(key: K, entity: { id: string }): void {
    const list = this.world[key] as unknown as { id: string }[];
    (this.world[key] as unknown) = [...list.filter((x) => x.id !== entity.id), entity];
  }

  /** Effective context limits: the thread's own, then `context.*` settings, then the model. */
  private contextLimits(threadId: string): EffectiveContextLimits {
    const own = this.world.contextLimits?.[threadId] ?? {};
    const set = (k: string) => {
      const v = this.world.settings[`context.${k}`];
      return typeof v === "number" ? v : undefined;
    };
    const contextWindow =
      this.world.contextUsage?.[threadId]?.limits.contextWindow ?? MOCK_CONTEXT_WINDOW;
    const fromSettings = set("maxTokens");
    return {
      maxTokens: Math.min(own.maxTokens ?? fromSettings ?? contextWindow, contextWindow),
      compactAt: own.compactAt ?? set("compactAt") ?? 0.8,
      keepRecentTurns: own.keepRecentTurns ?? set("keepRecentTurns") ?? 4,
      contextWindow,
      maxTokensFrom:
        own.maxTokens !== undefined ? "thread" : fromSettings !== undefined ? "settings" : "model",
    };
  }

  /** Records a turn's context usage and emits `thread.context.updated` (stories, tests). */
  reportContextUsage(usage: ContextUsage): void {
    this.world.contextUsage = { ...this.world.contextUsage, [usage.threadId]: usage };
    this.emit("thread.context.updated", { usage });
  }

  private thread(threadId: string): ThreadListEntry {
    return (
      this.world.threads.find((t) => t.thread.id === threadId) ??
      fail("not_found", `thread ${threadId} not found`)
    );
  }

  private patchThread(threadId: string, patch: Partial<ThreadListEntry["thread"]>) {
    const entry = this.thread(threadId);
    const thread = { ...entry.thread, ...patch, updatedAt: this.now() };
    this.world.threads = this.world.threads.map((t) =>
      t.thread.id === threadId ? { ...t, thread } : t,
    );
    this.emit("thread.updated", { thread });
    return { thread };
  }

  private patchTask(taskId: string, status: Task["status"]) {
    const task = { ...this.find(this.world.tasks, taskId, "task"), status, updatedAt: this.now() };
    this.replace("tasks", task);
    this.emit("task.updated", { task });
    return { task };
  }

  private modelProvider(id: string): ModelProviderSummary {
    const p = (this.world.modelProviders ?? []).find((x) => x.id === id);
    return p ?? fail("not_found", `no model provider "${id}"`);
  }

  private modelEntry(ref: string): ModelProviderSummary["models"][number] {
    const provider = this.modelProvider(ref.slice(0, ref.indexOf("/")));
    const entry = provider.models.find((m) => m.ref === ref);
    return entry ?? fail("not_found", `no configured provider serves ${ref}`);
  }

  private readonly handlers: { [M in MethodName]?: (params: MethodParams<M>) => unknown } = {
    "events.subscribe": () => ({ stateVersion: this.stateVersion }),

    "threads.list": (p) => ({
      threads: this.world.threads
        .filter((t) => p.includeArchived === true || t.thread.archivedAt == null)
        .filter((t) => p.kind === undefined || t.thread.kind === p.kind),
      nextCursor: null,
    }),
    "threads.get": (p) => this.thread(p.threadId),
    "threads.create": (p) => {
      const now = this.now();
      const thread: ThreadListEntry["thread"] = {
        id: this.id("thr"),
        kind: p.kind ?? "side",
        title: p.title ?? "New side chat",
        titleSource: p.title === undefined ? "auto" : "user",
        parentThreadId: p.parentThreadId ?? null,
        forkedFromMessageId: null,
        sessionKey: "owner:side",
        personaOverlay: null,
        permissionMode: p.permissionMode ?? "balanced",
        modelRef: p.modelRef ?? null,
        pinned: false,
        archivedAt: null,
        expiresAt: null,
        activeWriterRunId: null,
        createdAt: now,
        updatedAt: now,
        lastMessageAt: null,
      };
      this.world.threads.push({
        thread,
        activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
      });
      this.emit("thread.updated", { thread });
      return { thread };
    },
    "threads.rename": (p) => this.patchThread(p.threadId, { title: p.title, titleSource: "user" }),
    "threads.archive": (p) =>
      this.thread(p.threadId).thread.kind === "main"
        ? fail("forbidden", "the main chat cannot be archived")
        : this.patchThread(p.threadId, { archivedAt: this.now() }),
    "threads.restore": (p) => this.patchThread(p.threadId, { archivedAt: null }),
    "threads.update": (p) => {
      const current = this.thread(p.threadId).thread;
      const modelRef = p.modelRef === undefined ? current.modelRef : p.modelRef;
      // The real Gateway checks the auto-mode allowlist; the mock only refuses auto without a model.
      if (p.permissionMode === "auto" && !modelRef) {
        fail("forbidden", "Auto mode needs a model on the auto-mode allowlist");
      }
      return this.patchThread(p.threadId, {
        ...(p.permissionMode === undefined ? {} : { permissionMode: p.permissionMode }),
        modelRef: modelRef ?? null,
      });
    },
    "threads.pin": (p) => this.patchThread(p.threadId, { pinned: p.pinned }),
    "threads.delete": (p) => {
      this.thread(p.threadId);
      this.world.threads = this.world.threads.filter((t) => t.thread.id !== p.threadId);
      return { ok: true };
    },
    "threads.fork": (p) => {
      const source = this.thread(p.threadId).thread;
      const created = this.handlers["threads.create"]?.({
        kind: "side",
        title: p.title ?? `${source.title} (fork)`,
        parentThreadId: source.id,
      }) as { thread: ThreadListEntry["thread"] };
      return this.patchThread(created.thread.id, { forkedFromMessageId: p.messageId });
    },

    "threads.contextUsage": (p) => {
      this.thread(p.threadId);
      const limits = this.contextLimits(p.threadId);
      const usage = this.world.contextUsage?.[p.threadId];
      return {
        usage: usage === undefined ? null : { ...usage, limits },
        limits,
        threadLimits: this.world.contextLimits?.[p.threadId] ?? {},
      };
    },
    "threads.setContextLimits": (p) => {
      this.thread(p.threadId);
      const window = this.contextLimits(p.threadId).contextWindow;
      if (p.limits?.maxTokens !== undefined && p.limits.maxTokens > window)
        fail("invalid_params", `maxTokens is above the model's window (${window})`);
      const { [p.threadId]: _old, ...rest } = this.world.contextLimits ?? {};
      this.world.contextLimits = p.limits === null ? rest : { ...rest, [p.threadId]: p.limits };
      return {
        limits: this.contextLimits(p.threadId),
        threadLimits: this.world.contextLimits[p.threadId] ?? {},
      };
    },
    "threads.compact": (p) => {
      this.thread(p.threadId);
      if (this.world.runs.some((r) => r.threadId === p.threadId && r.status === "running"))
        fail("conflict", "the thread is running");
      const limits = this.contextLimits(p.threadId);
      const turns = this.world.messages
        .filter((m) => m.threadId === p.threadId && m.role !== "system")
        .sort((a, b) => a.seq - b.seq);
      const owner = turns.filter((m) => m.role === "user");
      const keepFrom = owner[owner.length - limits.keepRecentTurns];
      if (keepFrom === undefined || keepFrom === owner[0]) return { compaction: null };
      const replaced = turns.filter((m) => m.seq < keepFrom.seq);
      const before = this.world.contextUsage?.[p.threadId]?.promptTokens ?? replaced.length * 900;
      const after = Math.max(600, Math.round(before / 8));
      const compactionId = this.id("cmp");
      const message = this.commitMessage(p.threadId, "system", [
        {
          type: "compaction",
          compactionId,
          trigger: "manual",
          summary: { facts: [], decisions: [], openTasks: [], pinnedInstructions: [] },
          replaced: {
            turns: replaced.filter((m) => m.role === "user").length,
            fromMessageId: replaced[0]?.id ?? null,
            toMessageId: replaced[replaced.length - 1]?.id ?? null,
          },
          tokensBefore: before,
          tokensAfter: after,
        },
      ]);
      const usage = this.world.contextUsage?.[p.threadId];
      if (usage !== undefined)
        this.reportContextUsage({
          ...usage,
          promptTokens: after,
          breakdown: { ...usage.breakdown, history: Math.max(0, after - usage.breakdown.system) },
          compactions: usage.compactions + 1,
        });
      return {
        compaction: {
          compactionId,
          messageId: message.id,
          tokensBefore: before,
          tokensAfter: after,
          replacedTurns: replaced.filter((m) => m.role === "user").length,
        },
      };
    },

    "chat.history": (p) => ({
      messages: this.world.messages
        .filter((m) => m.threadId === p.threadId)
        .sort((a, b) => a.seq - b.seq),
      nextCursor: null,
    }),
    "chat.send": (p) => {
      const busy = this.world.runs.some((r) => r.threadId === p.threadId && r.status === "running");
      const message = this.commitMessage(p.threadId, "user", [{ type: "text", md: p.content }]);
      return { messageId: message.id, runId: null, queued: busy };
    },
    "chat.cancel": (p) => {
      const run = this.world.runs.find((r) => r.threadId === p.threadId && r.status === "running");
      if (run === undefined) return { cancelled: false };
      this.setRun({ ...run, status: "cancelled", endedAt: this.now() });
      return { cancelled: true };
    },
    "chat.steer": (p) => ({
      messageId: this.commitMessage(p.threadId, "user", [{ type: "text", md: p.content }]).id,
    }),
    "chat.followUp": (p) => ({
      messageId: this.commitMessage(p.threadId, "user", [{ type: "text", md: p.content }]).id,
    }),
    "chat.export": (p) => {
      const messages = this.world.messages.filter((m) => m.threadId === p.threadId);
      return p.format === "json"
        ? { mime: "application/json", content: JSON.stringify(messages, null, 2) }
        : {
            mime: "text/markdown",
            content: messages
              .map(
                (m) =>
                  `**${m.role}**: ${m.blocks.map((b) => (b.type === "text" ? b.md : `[${b.type}]`)).join("\n")}`,
              )
              .join("\n\n"),
          };
    },

    "tasks.list": (p) => ({
      tasks: this.world.tasks.filter(
        (t) =>
          (p.threadId === undefined || t.threadId === p.threadId) &&
          (p.status === undefined || p.status.includes(t.status)),
      ),
      nextCursor: null,
    }),
    "tasks.get": (p) => ({ task: this.find(this.world.tasks, p.taskId, "task") }),
    "tasks.actions": (p) => ({
      actions: this.world.taskActions
        .filter((a) => a.taskId === p.taskId)
        .sort((a, b) => a.idx - b.idx),
      nextCursor: null,
    }),
    "tasks.pause": (p) => this.patchTask(p.taskId, "paused"),
    "tasks.resume": (p) => this.patchTask(p.taskId, "running"),
    "tasks.cancel": (p) => this.patchTask(p.taskId, "cancelled"),
    "tasks.retry": (p) => {
      const t = this.find(this.world.tasks, p.taskId, "task");
      const task = {
        ...t,
        status: "queued" as const,
        attempt: t.attempt + 1,
        updatedAt: this.now(),
      };
      this.replace("tasks", task);
      this.emit("task.updated", { task });
      return { task };
    },

    "approvals.list": (p) => {
      const statuses = p.status ?? ["pending"];
      const approvals = this.world.approvals.filter((a) => statuses.includes(a.status));
      const answerTokens: Record<string, string> = {};
      for (const a of approvals) {
        const t = this.world.answerTokens[a.id];
        if (a.status === "pending" && t !== undefined) answerTokens[a.id] = t;
      }
      return { approvals, answerTokens, nextCursor: null };
    },
    "approvals.get": (p) => {
      const approval = this.find(this.world.approvals, p.approvalId, "approval");
      const token = this.world.answerTokens[approval.id];
      return approval.status === "pending" && token !== undefined
        ? { approval, answerToken: token }
        : { approval };
    },
    "approvals.answer": (p) => {
      const approval = this.find(this.world.approvals, p.approvalId, "approval");
      if (approval.status !== "pending") fail("answer_late", "this approval was already decided");
      if (this.world.answerTokens[approval.id] !== p.answerToken)
        fail("answer_replayed", "the answer token is not valid for this surface");
      if (Date.parse(approval.expiresAt) < Date.parse(this.now()))
        fail("approval_expired", "this approval expired");
      if (
        p.decision === "approve" &&
        p.scope !== undefined &&
        !approval.scopesOffered.includes(p.scope)
      )
        fail("invalid_params", `scope ${p.scope} was not offered`);
      delete this.world.answerTokens[approval.id];
      const decided: ApprovalRequest = {
        ...approval,
        status: p.decision === "approve" ? "approved" : "denied",
        scopeGranted: p.decision === "approve" ? (p.scope ?? "once") : null,
        decidedBy: { deviceId: "dev_this", surface: "desktop" },
        decidedAt: this.now(),
      };
      this.replace("approvals", decided);
      this.emit("approval.updated", { approval: decided });
      return { approval: decided, grant: null };
    },
    "grants.list": (p) => ({
      grants: this.world.grants.filter((g) => p.includeRevoked === true || g.revokedAt == null),
    }),
    "grants.revoke": (p) => {
      const grant = { ...this.find(this.world.grants, p.grantId, "grant"), revokedAt: this.now() };
      this.replace("grants", grant);
      return { grant };
    },

    "questions.list": (p) => ({
      inputRequests: this.world.inputRequests.filter(
        (r) =>
          (p.threadId === undefined || r.threadId === p.threadId) &&
          (p.taskId === undefined || r.taskId === p.taskId) &&
          (p.status ?? ["open"]).includes(r.status),
      ),
      nextCursor: null,
    }),
    "questions.get": (p) => ({
      inputRequest: this.find(this.world.inputRequests, p.inputRequestId, "input request"),
    }),
    "questions.answer": (p) => {
      const r = this.find(this.world.inputRequests, p.inputRequestId, "input request");
      if (r.status !== "open") fail("conflict", "this question was already answered");
      const inputRequest: InputRequest = {
        ...r,
        status: "answered",
        answer: p.answer,
        answeredAt: this.now(),
        answeredByDeviceId: "dev_this",
      };
      this.replace("inputRequests", inputRequest);
      this.emit("question.updated", { inputRequest });
      return { inputRequest };
    },

    "receipts.get": (p) => ({ receipt: this.find(this.world.receipts, p.receiptId, "receipt") }),
    "receipts.list": (p) => ({
      receipts: this.world.receipts.filter((r) => p.taskId === undefined || r.taskId === p.taskId),
      nextCursor: null,
    }),
    "artifacts.get": (p) => ({
      artifact: this.find(this.world.artifacts, p.artifactId, "artifact"),
    }),
    "files.list": (p) => {
      this.assertGranted(p.path);
      const node = this.world.files[p.path];
      if (node === undefined) return fail("not_found", `${p.path} does not exist`);
      if (node.kind !== "folder") fail("invalid_params", `${p.path} is not a folder`);
      const prefix = `${p.path}/`;
      const rank = (k: string) => (k === "folder" ? 0 : k === "file" ? 1 : 2);
      const entries = Object.entries(this.world.files)
        .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .map(([path, n]) => ({
          name: path.slice(prefix.length),
          path,
          kind: n.kind,
          size: n.kind === "file" ? new TextEncoder().encode(n.text).length : null,
          modifiedAt: n.kind === "other" ? null : (n.modifiedAt ?? null),
        }))
        .sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name));
      return { entries, nextOffset: null };
    },
    "files.read": (p) => {
      if ((p.path === undefined) === (p.libraryPath === undefined))
        fail("invalid_params", "pass exactly one of path and libraryPath");
      let name: string;
      let bytes: Uint8Array;
      let modifiedAt: string;
      if (p.path !== undefined) {
        this.assertGranted(p.path);
        const node = this.world.files[p.path];
        if (node === undefined) return fail("not_found", `${p.path} does not exist`);
        if (node.kind !== "file") return fail("invalid_params", `${p.path} is not a file`);
        name = p.path.split("/").pop() ?? p.path;
        bytes = new TextEncoder().encode(node.text);
        modifiedAt = node.modifiedAt ?? this.now();
      } else {
        const item = this.world.library.find((i) => i.path === p.libraryPath);
        if (item === undefined) return fail("not_found", `${p.libraryPath} is not in the Library`);
        name = item.name;
        bytes = new TextEncoder().encode(`Fixture content of ${item.name}`);
        modifiedAt = item.createdAt;
      }
      const offset = p.offset ?? 0;
      if (offset > bytes.length) fail("invalid_params", `offset ${offset} is past the end`);
      const end = Math.min(bytes.length, offset + (p.length ?? FILE_CHUNK_BYTES));
      return {
        name,
        mime: mockMime(name),
        modifiedAt,
        etag: `${bytes.length}-${modifiedAt}`,
        size: bytes.length,
        offset,
        bytes: toBase64(bytes.subarray(offset, end)),
        nextOffset: end < bytes.length ? end : null,
      };
    },
    // Like a Gateway without the full sandbox image: conversion is unavailable.
    "documents.convert": () =>
      fail("unavailable", "The full sandbox image with LibreOffice is not installed."),
    "library.list": (p) => ({
      items: this.world.library.filter(
        (i) =>
          (p.kind === undefined || i.kind === p.kind) &&
          (p.taskId === undefined || i.taskId === p.taskId) &&
          (p.threadId === undefined || i.threadId === p.threadId) &&
          (p.query === undefined || i.name.toLowerCase().includes(p.query.toLowerCase())),
      ),
      nextCursor: null,
    }),
    "library.get": (p) => ({ item: this.find(this.world.library, p.itemId, "library item") }),
    "library.delete": (p) => {
      this.world.library = this.world.library.filter((i) => i.id !== p.itemId);
      return { ok: true };
    },

    "feed.list": () => ({
      posts: this.world.feed,
      nextBriefAt: this.world.nextBriefAt,
      nextCursor: null,
    }),
    "feed.generate": () => {
      this.emit("feed.updated", { posts: this.world.feed });
      return { posts: this.world.feed };
    },
    "feed.feedback": (p) => {
      const post = {
        ...this.find(this.world.feed, p.postId, "post"),
        feedback: p.feedback ?? null,
      };
      this.replace("feed", post);
      this.emit("feed.post", { post });
      return { post };
    },
    "ideas.list": (p) => ({
      ideas: this.world.ideas.filter((i) => (p.status ?? ["proposed"]).includes(i.status)),
      nextCursor: null,
    }),
    "ideas.accept": (p) => {
      const idea: Idea = {
        ...this.find(this.world.ideas, p.ideaId, "idea"),
        status: p.brief === undefined ? "accepted" : "edited",
        decidedAt: this.now(),
      };
      this.replace("ideas", idea);
      this.emit("idea.updated", { idea });
      return {
        idea,
        taskId: p.recurring === true ? null : this.id("task"),
        automationId: p.recurring === true ? this.id("auto") : null,
      };
    },
    "ideas.dismiss": (p) => {
      const idea: Idea = {
        ...this.find(this.world.ideas, p.ideaId, "idea"),
        status: "dismissed",
        decidedAt: this.now(),
      };
      this.replace("ideas", idea);
      this.emit("idea.updated", { idea });
      return { idea };
    },
    "goals.list": (p) => ({
      goals: this.world.goals.filter(
        (g) =>
          (p.status ?? ["active", "candidate"]).includes(g.status) &&
          (p.category === undefined || g.category === p.category),
      ),
    }),
    "goals.get": (p) => this.goalDetail(p.goalId),
    "goals.create": (p) => {
      const now = this.now();
      const goal: Goal = {
        id: this.id("goal"),
        title: p.title,
        category: p.category,
        status: "active",
        inferred: false,
        confirmedAt: now,
        plan: p.plan ?? null,
        cadence: p.cadence ?? null,
        nextCheckinAt: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.world.goals = [...this.world.goals, goal];
      this.milestones.set(
        goal.id,
        (p.milestones ?? []).map((m) => ({
          id: this.id("ms"),
          goalId: goal.id,
          title: m.title,
          dueAt: m.dueAt ?? null,
          doneAt: null,
        })),
      );
      this.emit("goal.updated", { goal });
      return this.goalDetail(goal.id);
    },
    "goals.archive": (p) => {
      const goal: Goal = {
        ...this.find(this.world.goals, p.goalId, "goal"),
        status: "archived",
        archivedAt: this.now(),
        updatedAt: this.now(),
      };
      this.replace("goals", goal);
      this.emit("goal.updated", { goal });
      return { goal };
    },
    "goals.milestone": (p) => {
      const list = this.goalMilestones(p.goalId);
      if (p.milestoneId === undefined) {
        if (p.title === undefined) fail("invalid_params", "a new milestone needs a title");
        list.push({
          id: this.id("ms"),
          goalId: p.goalId,
          title: p.title as string,
          dueAt: p.dueAt ?? null,
          doneAt: null,
        });
      } else {
        const i = list.findIndex((m) => m.id === p.milestoneId);
        const m = list[i] ?? fail("not_found", `milestone ${p.milestoneId} not found`);
        if (p.remove === true) list.splice(i, 1);
        else
          list[i] = {
            ...m,
            ...(p.title === undefined ? {} : { title: p.title }),
            ...(p.dueAt === undefined ? {} : { dueAt: p.dueAt }),
            ...(p.done === undefined ? {} : { doneAt: p.done ? this.now() : null }),
          };
      }
      return this.goalDetail(p.goalId);
    },
    "goals.decide": (p) => {
      const g = this.find(this.world.goals, p.goalId, "goal");
      const goal: Goal =
        p.decision === "later"
          ? g
          : {
              ...g,
              status: p.decision === "confirm" ? "active" : "archived",
              confirmedAt: p.decision === "confirm" ? this.now() : (g.confirmedAt ?? null),
              updatedAt: this.now(),
            };
      this.replace("goals", goal);
      this.emit("goal.updated", { goal });
      return { goal };
    },

    "notifications.list": (p) => ({
      notifications: this.world.notifications.filter(
        (n) =>
          (p.unreadOnly !== true || n.readAt == null) &&
          (p.unresolvedOnly !== true || n.resolvedAt == null),
      ),
      nextCursor: null,
    }),
    "notifications.markRead": (p) => {
      let updated = 0;
      this.world.notifications = this.world.notifications.map((n) => {
        if (!p.notificationIds.includes(n.id) || n.readAt != null) return n;
        updated += 1;
        return { ...n, readAt: this.now() };
      });
      return { updated };
    },
    "notifications.resolve": (p) => {
      const notification = {
        ...this.find(this.world.notifications, p.notificationId, "notification"),
        resolvedAt: this.now(),
        readAt: this.now(),
      };
      this.replace("notifications", notification);
      return { notification };
    },

    "settings.get": (p) => ({
      settings:
        p.keys === undefined
          ? this.world.settings
          : Object.fromEntries(p.keys.map((k) => [k, this.world.settings[k]])),
      stateVersion: this.stateVersion,
    }),
    "settings.set": (p) => {
      this.world.settings[p.key] = p.value;
      const entry = { key: p.key, value: p.value, updatedAt: this.now() };
      this.emit("settings.changed", { entries: [entry] });
      return { entry, stateVersion: this.stateVersion };
    },

    "models.list": () => ({
      providers: this.world.modelProviders ?? [],
      roles: this.world.modelRoles ?? {},
    }),
    "models.probe": (p) => {
      const provider = this.modelProvider(p.providerId);
      const found = this.world.modelProbes?.[p.providerId];
      const probe: EndpointProbe = found ?? {
        state: "unreachable",
        probedAt: this.now(),
        models: [],
        error: `nothing answered at ${provider.baseURL ?? provider.id}`,
      };
      provider.probe = structuredClone(probe);
      for (const m of probe.models) {
        const known = provider.models.find((x) => x.ref === m.ref);
        if (known === undefined) {
          provider.models.push({ ref: m.ref, capabilities: m.capabilities, toolCheck: "untested" });
        } else known.capabilities = m.capabilities;
      }
      return { provider };
    },
    "models.check": (p) => {
      const entry = this.modelEntry(p.ref);
      entry.toolCheck = "agent-capable";
      return {
        result: {
          ref: p.ref,
          status: "agent-capable",
          passed: 6,
          total: 6,
          inconclusive: false,
          probedAt: this.now(),
        },
      };
    },
    "models.setRole": (p) => {
      const entry = this.modelEntry(p.ref);
      if (p.role === "primary" && entry.toolCheck === "chat-only" && p.override !== true) {
        fail("policy_denied", `${p.ref} failed the tool-calling probe and is chat-only`);
      }
      this.world.modelRoles = { ...this.world.modelRoles, [p.role]: p.ref };
      const key = `models.${p.role}`;
      this.world.settings[key] = p.ref;
      this.emit("settings.changed", { entries: [{ key, value: p.ref, updatedAt: this.now() }] });
      return { roles: this.world.modelRoles };
    },

    "automations.list": () => ({ automations: this.world.automations }),
    "automations.run": () => ({ runId: this.id("run"), taskId: this.id("task") }),
    "automations.update": (p) => {
      const { automationId, ...fields } = p;
      const automation = {
        ...this.find(this.world.automations, automationId, "automation"),
        ...fields,
        updatedAt: this.now(),
      };
      this.replace("automations", automation);
      return { automation };
    },
    "automations.delete": (p) => {
      this.world.automations = this.world.automations.filter((a) => a.id !== p.automationId);
      return { ok: true };
    },

    "search.query": (p) => {
      const q = p.query.toLowerCase().trim();
      return {
        hits: this.world.searchHits.filter(
          (h) =>
            (p.scopes === undefined || p.scopes.includes(h.scope)) &&
            (q === "" || h.title.toLowerCase().includes(q) || h.snippet.toLowerCase().includes(q)),
        ),
      };
    },

    "memory.read": (p) => {
      const content = this.world.memoryFiles[p.path] ?? fail("not_found", `${p.path} not found`);
      return { path: p.path, content, updatedAt: this.now(), etag: etagOf(content) };
    },
    "memory.write": (p) => {
      const current = this.world.memoryFiles[p.path];
      if (p.etag !== undefined && current !== undefined && etagOf(current) !== p.etag)
        fail("conflict", `${p.path} changed since it was read`);
      const content = p.mode === "append" ? `${current ?? ""}${p.content}` : p.content;
      this.world.memoryFiles[p.path] = content;
      this.emit("memory.file.changed", {
        path: p.path,
        etag: etagOf(content),
        source: "api",
        provenance: "owner",
      });
      return { path: p.path, bytes: content.length, updatedAt: this.now(), etag: etagOf(content) };
    },
    "memory.files.list": (p) => ({
      files: Object.entries(this.world.memoryFiles)
        .filter(([path]) => p.prefix === undefined || path.startsWith(p.prefix))
        .map(([path, content]) => ({
          path,
          bytes: content.length,
          etag: etagOf(content),
          protected: !path.startsWith("memory/"),
          provenance: "owner" as const,
          updatedAt: this.now(),
        })),
    }),
    "memory.daily.list": () => ({
      notes: Object.entries(this.world.memoryFiles)
        .filter(([path]) => /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(path))
        .map(([path, content]) => ({
          date: path.slice(7, 17),
          path,
          entries: content.split("\n").filter((l) => l.startsWith("- ")).length,
          bytes: content.length,
        }))
        .sort((a, b) => b.date.localeCompare(a.date)),
    }),
    "memory.status": () => ({
      paused: this.world.settings["memory.paused"] === true,
      vectorSearch: "sqlite-vec" as const,
      files: Object.keys(this.world.memoryFiles).length,
      chunks: 128,
      claims: 42,
      lastJobs: [],
    }),
    "memory.pause": (p) => {
      this.world.settings["memory.paused"] = p.paused;
      return { paused: p.paused };
    },
    "memory.search": (p) => {
      const q = p.query.toLowerCase();
      const hits = Object.entries(this.world.memoryFiles).flatMap(([path, content]) =>
        content
          .split("\n")
          .flatMap((line, i) =>
            line.toLowerCase().includes(q)
              ? [{ chunk: this.chunk(path, i + 1, line), score: 1 / (i + 1) }]
              : [],
          ),
      );
      return { hits: hits.slice(0, p.limit ?? 20) };
    },
    "memory.claims.list": (p) => ({
      claims: this.world.memoryClaims.filter(
        (c) => p.includeRetracted === true || c.retractedAt == null,
      ),
    }),
    "memory.explain": (p) => {
      const claim = this.find(this.world.memoryClaims, p.claimId, "claim");
      const chunks = claim.sources.map((source, i) => this.chunk(source, i + 1, claim.text));
      return { claim, chunks };
    },
    "memory.remember": (p) => {
      const path = `memory/${this.now().slice(0, 10)}.md`;
      const before = this.world.memoryFiles[path] ?? "";
      const after = before === "" ? `- ${p.text}` : `${before}\n- ${p.text}`;
      this.world.memoryFiles[path] = after;
      return { path, chunk: this.chunk(path, after.split("\n").length, p.text) };
    },
    "memory.forget": (p) => {
      const q = p.subject.toLowerCase();
      const files = Object.entries(this.world.memoryFiles)
        .filter(([, c]) => c.toLowerCase().includes(q))
        .map(([path]) => path);
      const claims = this.world.memoryClaims.filter((c) => c.text.toLowerCase().includes(q));
      if (p.dryRun !== true) {
        for (const path of files) {
          const content = this.world.memoryFiles[path] ?? "";
          this.world.memoryFiles[path] = content
            .split("\n")
            .filter((l) => !l.toLowerCase().includes(q))
            .join("\n");
        }
      }
      return { retractedClaimIds: claims.map((c) => c.id), removedChunkIds: [], files };
    },
    "memory.export": () => ({
      filename: "psyche-memory.zip",
      mime: "application/zip" as const,
      // An empty zip archive (end-of-central-directory record only).
      data: "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==",
      bytes: 22,
    }),
    "memory.reset": (p) => ({
      files: Object.keys(this.world.memoryFiles),
      chunks: 128,
      claims: 42,
      dryRun: p.dryRun ?? false,
    }),

    "connectors.list": () => ({ connectors: this.world.connectors }),
    "channels.list": () => ({ channels: this.world.channels }),
    "devices.list": () => ({ devices: this.world.devices }),
    "browser.botAuth.status": () => ({ status: structuredClone(this.world.botAuth) }),
    "browser.botAuth.rotate": () => {
      // A fresh fake thumbprint each time, as a real rotation gives.
      this.world.botAuth = {
        ...this.world.botAuth,
        keyId: `fixture-key-${this.calls.length}`,
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "fixture-public-key" },
        createdAt: this.now(),
      };
      return { status: structuredClone(this.world.botAuth) };
    },
    "skills.list": () => ({ skills: this.world.skills }),
    "skills.commands": () => ({
      commands: this.world.skills
        .filter((x) => x.enabled && x.userInvocable)
        .map((x) => ({
          command: `/${x.name}`,
          name: x.name,
          description: x.description,
          source: x.source,
          trust: x.trust,
        })),
    }),
    "skills.proposeInstall": (p) => {
      const key = p.source.kind === "git" ? p.source.url : p.source.path;
      return this.stageSkill(this.world.skillSources[key], `nothing to install at ${key}`);
    },
    "skills.proposeUpdate": (p) =>
      this.stageSkill(this.world.skillSources[`update:${p.name}`], `${p.name} is up to date`),
    "skills.getProposal": (p) => ({
      proposal:
        this.skillProposals.get(p.proposalId) ?? fail("not_found", "no such install proposal"),
    }),
    "skills.install": (p) => {
      const proposal =
        this.skillProposals.get(p.proposalId) ?? fail("not_found", "no such install proposal");
      const approval = this.find(this.world.approvals, p.approvalId, "approval");
      if (
        approval.kind !== "skill_install" ||
        approval.status !== "approved" ||
        approval.bindingHash !== proposal.bindingHash
      )
        fail("approval_required", "installing a skill needs an approved skill_install");
      this.skillProposals.delete(p.proposalId);
      const blocked = proposal.findings.some((f) => f.severity === "high");
      const details: SkillDetails = {
        name: proposal.name,
        description: /description: (.*)/.exec(proposal.text)?.[1] ?? proposal.name,
        source: "home",
        path: `~/.psyche/skills/${proposal.name}/SKILL.md`,
        trust: proposal.trust,
        userInvocable: true,
        disableModelInvocation: false,
        enabled: !blocked,
        hash: proposal.hash,
        status: blocked ? "blocked" : "active",
        reasons: blocked ? ["the static scan has high-severity findings"] : [],
        findings: proposal.findings,
        userEnabled: true,
        overrides: [],
        ...(proposal.manifest === undefined ? {} : { manifest: proposal.manifest }),
      };
      this.world.skills = [
        ...this.world.skills.filter((x) => !(x.name === details.name && x.source === "home")),
        details,
      ];
      this.emit("skills.changed", {
        type: "installed",
        name: details.name,
        hash: details.hash,
        enabled: details.enabled,
      });
      const {
        status: _s,
        reasons: _r,
        findings: _f,
        userEnabled: _u,
        overrides: _o,
        manifest: _m,
        ...summary
      } = details;
      return { skill: summary };
    },
    "skills.setEnabled": (p) => {
      const current =
        this.world.skills.find((x) => x.name === p.name) ?? fail("not_found", `no skill ${p.name}`);
      if (p.enabled && current.findings.some((f) => f.severity === "high"))
        fail(
          "policy_denied",
          `cannot enable ${p.name}: the static scan has high-severity findings`,
        );
      const skill: SkillDetails = {
        ...current,
        userEnabled: p.enabled,
        enabled: p.enabled,
        status: p.enabled ? "active" : "disabled",
        reasons: p.enabled ? [] : ["disabled by the owner"],
      };
      this.world.skills = this.world.skills.map((x) => (x === current ? skill : x));
      this.emit("skills.changed", { type: "reloaded", added: [], removed: [], changed: [p.name] });
      return { skill };
    },
    "skills.remove": (p) => {
      const current = this.world.skills.find((x) => x.name === p.name && x.source !== "bundled");
      if (current === undefined) {
        if (this.world.skills.some((x) => x.name === p.name))
          fail("policy_denied", "bundled skills cannot be removed; disable them");
        fail("not_found", `no installed skill named ${p.name}`);
      }
      this.world.skills = this.world.skills.filter((x) => x !== current);
      this.emit("skills.changed", { type: "removed", name: p.name, source: "home" });
      return { ok: true as const };
    },
    "skills.checkUpdates": (p) => ({
      updates: this.world.skills
        .filter((x) => x.source === "home" && (p.name === undefined || x.name === p.name))
        .map(
          (x) =>
            x.update ?? {
              name: x.name,
              installedHash: x.hash,
              availableHash: x.hash,
              updateAvailable: false,
              manifestChanged: false,
              checkedAt: Date.parse(this.now()),
            },
        ),
    }),
    "devices.pairing.list": () => ({ pairingRequests: this.world.pairingRequests }),
    "nodes.list": () => ({ nodes: this.world.nodes }),
    "vault.list": () => ({ credentials: this.world.credentials }),
    "vault.add": (p) => {
      // The mock never keeps the secret. Like the vault, it refuses card-like numbers.
      if (/\b(?:\d[ -]?){13,19}\b/.test(JSON.stringify(p.secret)))
        fail("policy_denied", "Card numbers are refused; connect a payment link instead.");
      const now = this.now();
      const credential: CredentialMeta = {
        id: this.id("cred"),
        kind: p.kind,
        name: p.name,
        slug:
          p.slug ??
          p.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, ""),
        bindings: p.bindings,
        ownerConnectorId: null,
        lastUsedAt: null,
        useCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.world.credentials = [...this.world.credentials, credential];
      return { credential };
    },
    "vault.update": (p) => {
      const current = this.world.credentials.find((c) => c.id === p.credentialId);
      if (current === undefined) return fail("not_found", "No such vault item.");
      if (current.ownerConnectorId !== null) fail("forbidden", "Its connector manages this item.");
      if (p.secret !== undefined && /\b(?:\d[ -]?){13,19}\b/.test(JSON.stringify(p.secret)))
        fail("policy_denied", "Card numbers are refused; connect a payment link instead.");
      // The mock never keeps the secret; omitted fields stay as they are.
      const credential: CredentialMeta = {
        ...current,
        ...(p.name === undefined ? {} : { name: p.name }),
        ...(p.bindings === undefined ? {} : { bindings: p.bindings }),
        updatedAt: this.now(),
      };
      this.world.credentials = this.world.credentials.map((c) =>
        c.id === credential.id ? credential : c,
      );
      this.emit("credential.updated", {
        credentialId: credential.id,
        change: "updated",
        credential,
        ownerConnectorId: null,
      });
      return { credential };
    },
    "vault.linkExternal": (p) => {
      // The mock keeps the reference only, like the vault: no value is ever read here.
      const now = this.now();
      const credential: CredentialMeta = {
        id: this.id("cred"),
        kind: p.kind,
        name: p.name,
        slug:
          p.slug ??
          p.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, ""),
        bindings: p.bindings,
        ownerConnectorId: null,
        lastUsedAt: null,
        useCount: 0,
        createdAt: now,
        updatedAt: now,
        backend: "1password",
      };
      this.world.credentials = [...this.world.credentials, credential];
      this.emit("credential.updated", {
        credentialId: credential.id,
        change: "created",
        credential,
        ownerConnectorId: null,
      });
      return { credential };
    },
    "vault.payments.methods": () => ({ methods: this.linkWallet() }),
    "vault.payments.list": (p) => {
      this.linkWallet();
      return {
        payments: (this.world.payments ?? [])
          .filter((x) => p.taskId === undefined || x.taskId === p.taskId)
          .slice(0, p.limit ?? 50),
      };
    },
    "vault.uses": (p) => ({
      uses: this.world.credentialUses
        .filter((u) => u.credentialId === p.credentialId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, p.limit ?? 50),
    }),
    "vault.import": (p) => {
      // A small stand-in for packages/vault's importer: it reads the header to find the name,
      // site and password columns, refuses card-like rows, and never keeps a value.
      const rows = p.csv
        .split(/\r?\n/)
        .filter((l) => l.trim() !== "")
        .map((l) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, "")));
      const header = (rows[0] ?? []).map((h) => h.toLowerCase());
      const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
      const nameAt = col("name", "title");
      const siteAt = col("url", "website", "login_uri");
      const passwordAt = col("password", "login_password");
      if (nameAt < 0 || passwordAt < 0)
        fail("invalid_params", "The CSV header is not a 1Password, Bitwarden or Chrome export.");
      const imported: CredentialMeta[] = [];
      const skipped: { row: number; reason: string }[] = [];
      rows.slice(1).forEach((r, i) => {
        const row = i + 2;
        const name = r[nameAt] ?? "";
        const password = r[passwordAt] ?? "";
        if (name === "" || password === "") {
          skipped.push({ row, reason: "no name or password" });
          return;
        }
        if (/\b(?:\d[ -]?){13,19}\b/.test(r.join(" "))) {
          skipped.push({ row, reason: "looks like a card number" });
          return;
        }
        const site = siteAt < 0 ? "" : (r[siteAt] ?? "");
        const now = this.now();
        imported.push({
          id: this.id("cred"),
          kind: "login",
          name,
          slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-login`,
          bindings: /^https?:\/\//.test(site) ? [{ origin: new URL(site).origin }] : [],
          ownerConnectorId: null,
          lastUsedAt: null,
          useCount: 0,
          createdAt: now,
          updatedAt: now,
        });
      });
      this.world.credentials = [...this.world.credentials, ...imported];
      for (const credential of imported) {
        this.emit("credential.updated", {
          credentialId: credential.id,
          change: "created",
          credential,
          ownerConnectorId: null,
        });
      }
      return { imported, skipped };
    },
    "vault.delete": (p) => {
      const current = this.world.credentials.find((c) => c.id === p.credentialId);
      if (current === undefined) return { deleted: false };
      if (current.ownerConnectorId !== null) fail("forbidden", "Its connector manages this item.");
      this.world.credentials = this.world.credentials.filter((c) => c.id !== current.id);
      this.emit("credential.updated", {
        credentialId: current.id,
        change: "deleted",
        credential: null,
        ownerConnectorId: null,
      });
      return { deleted: true };
    },
    "channels.pairing.list": (p) => ({
      requests: this.world.pairingRequests.filter(
        (r) =>
          r.kind === "channel-sender" &&
          (p.channelId === undefined || r.channelId === p.channelId) &&
          (p.status === undefined || r.status === p.status),
      ),
    }),
    "channels.identities.list": () => ({ identities: this.world.channelIdentities }),
    "channels.pairing.approve": (p) => ({ pairingRequest: this.decidePairing(p, "approved") }),
    "channels.pairing.deny": (p) => ({ pairingRequest: this.decidePairing(p, "denied") }),
    "channels.configure": (p) => {
      const { channelId, ...fields } = p;
      const current =
        channelId === undefined ? undefined : this.find(this.world.channels, channelId, "channel");
      if (current === undefined) fail("not_implemented", "MockGateway does not create channels");
      const channel: Channel = {
        ...(current as Channel),
        ...fields,
        updatedAt: this.now(),
      } as Channel;
      this.replace("channels", channel);
      return { channel };
    },
    "devices.approve": (p) => {
      const req = this.decidePairing({ requestId: p.pairingRequestId }, "approved");
      const now = this.now();
      const device: Device = {
        id: req.deviceId ?? this.id("dev"),
        name: req.display,
        platform: "macos",
        role: "client",
        publicKey: "mock-public-key",
        scopes: p.scopes,
        pairedAt: now,
        lastSeenAt: now,
        revokedAt: null,
      };
      this.replace("devices", device);
      this.emit("device.updated", { device });
      return { device };
    },
    "devices.deny": (p) => ({
      pairingRequest: this.decidePairing({ requestId: p.pairingRequestId }, "denied"),
    }),
    "devices.revoke": (p) => {
      const device = {
        ...this.find(this.world.devices, p.deviceId, "device"),
        revokedAt: this.now(),
      };
      this.replace("devices", device);
      this.emit("device.updated", { device });
      return { device };
    },
    "sandbox.status": () => ({
      backend: "apple-container" as const,
      available: true,
      sandbox: null,
    }),
  };

  private decidePairing(
    p: { requestId?: string; code?: string },
    status: "approved" | "denied",
  ): PairingRequest {
    const req =
      this.world.pairingRequests.find(
        (r) =>
          (p.requestId !== undefined && r.id === p.requestId) ||
          (p.code !== undefined && r.code === p.code),
      ) ?? fail("not_found", "pairing request not found");
    if (req.status !== "pending") fail("conflict", "this request was already decided");
    const decided: PairingRequest = {
      ...req,
      status,
      decidedAt: this.now(),
      decidedByDeviceId: "dev_this",
    };
    this.replace("pairingRequests", decided);
    return decided;
  }

  private readonly milestones = new Map<string, GoalMilestone[]>();

  /** Milestones per goal; seeded from the fixture convention `plan.milestones: {title, done}[]`. */
  private goalMilestones(goalId: string): GoalMilestone[] {
    let list = this.milestones.get(goalId);
    if (list === undefined) {
      const goal = this.find(this.world.goals, goalId, "goal");
      const raw = (goal.plan as { milestones?: { title?: unknown; done?: unknown }[] } | null)
        ?.milestones;
      list = (Array.isArray(raw) ? raw : []).map((m, i) => ({
        id: `${goalId}_ms_${i + 1}`,
        goalId,
        title: String(m.title ?? `Milestone ${i + 1}`),
        dueAt: null,
        doneAt: m.done === true ? goal.updatedAt : null,
      }));
      this.milestones.set(goalId, list);
    }
    return list;
  }

  private goalDetail(goalId: string) {
    const goal = this.find(this.world.goals, goalId, "goal");
    const taskIds = this.world.tasks.filter((t) => t.createdFrom === "goal").map((t) => t.id);
    return { goal, taskIds, milestones: [...this.goalMilestones(goalId)], links: [] };
  }

  private chunk(source: string, line: number, text: string): MemoryChunk {
    return {
      id: `chunk_${source.replace(/[^a-z0-9]/gi, "_")}_${line}`,
      source,
      lineStart: line,
      lineEnd: line,
      text,
      provenance: "owner",
      claimId: null,
      tokenCount: Math.ceil(text.length / 4),
      createdAt: this.now(),
      updatedAt: this.now(),
    };
  }

  private delay(): Promise<void> {
    return this.latency > 0 ? sleep(this.latency) : Promise.resolve();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Stable short etag for mock files. */
function etagOf(content: string): string {
  let h = 2166136261;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `e${(h >>> 0).toString(16)}`;
}
