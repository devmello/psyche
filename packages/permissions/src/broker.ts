import { randomBytes } from "node:crypto";
import { Receipts, sha256 } from "@psyche/audit";
import {
  APPROVAL_ARM_DELAY_MS,
  APPROVAL_TTL_MS,
  type ApprovalKind,
  type ApprovalRequest,
  type ApprovalStatus,
  type AuditEntryInput,
  type AuditLog,
  type BindingVerification,
  type Clock,
  type DecidedBy,
  type DeviceScope,
  type ErrorCode,
  type Grant,
  type GrantFilter,
  type GrantScope,
  type IssuedApproval,
  isPrepNoteCall,
  type JsonObject,
  type Notifier,
  type PermissionBroker,
  PREP_NOTE_TITLE_PREFIX,
  type PreviewResult,
  PsycheError,
  type Receipt,
  type ReceiptInput,
  type SideEffect,
  type Surface,
  type ToolCallIntent,
} from "@psyche/protocol";
import { monotonicFactory } from "ulid";
import { type Binding, bindingFor, bindingHash } from "./binding.ts";
import { cardHeader, sanitizeDetails, sanitizeDisplay } from "./cards.ts";
import {
  CHANNEL_PAIRING_WINDOW_MS,
  CHANNEL_REPLIES_PER_MINUTE,
  CHANNEL_REPLY_TTL_MS,
  CHANNEL_REPLY_WINDOW_MS,
  type ChannelConversationLookup,
  type ChannelReplyInput,
} from "./channel-reply.ts";
import { type ActionClassifier, RulesClassifier } from "./classifier.ts";
import {
  type DryRun,
  newTaskState,
  PolicyEngine,
  type PolicyHook,
  safeOrigin,
  type TaskState,
  targetKey,
  taskKey,
} from "./engine.ts";
import { type FolderAccessEnv, type FolderGrantEntry, resolveFolderPick } from "./folder-access.ts";
import {
  AUTH_KINDS,
  allowedScopes,
  DEVICE_ONLY_KINDS,
  inferApprovalKind,
  isDeviceOnly,
  SEVERITY,
} from "./kinds.ts";
import { type CompiledPolicy, compilePolicy, type PolicyConfig } from "./policy.ts";
import { DENY_ALL_LOOPBACK, type LocalProjectVerifier } from "./prohibitions.ts";
import { requesterKey, requesterSurfaces } from "./requester.ts";
import type { RevocationLedger } from "./revocations.ts";
import {
  MemoryPermissionStore,
  type PermissionStore,
  type StoredApproval,
  type StoredGrant,
} from "./store.ts";
import type {
  BatchChild,
  PolicyAnswerInput,
  PolicyApprovalInput,
  PolicyBatchInput,
  PolicyCall,
  PolicyContext,
  PolicyDecision,
  PresenceAssertion,
  TaintSource,
} from "./types.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Who may answer (security §3.7): paired devices with `operator.approvals`, owner-identity senders. */
export interface ApproverDirectory {
  device(
    deviceId: string,
  ): Promise<{ scopes: readonly DeviceScope[]; revoked?: boolean; role?: string } | undefined>;
  /** True only for `commands.ownerAllowFrom` identities, never for merely allowlisted senders. */
  isOwnerSender(channel: string, senderId: string): Promise<boolean>;
}

/** Verifies a WebAuthn / helper Touch ID assertion over `presenceChallenge(...)` (design-04). */
export interface PresenceVerifier {
  verify(assertion: PresenceAssertion, challenge: string, deviceId: string): Promise<boolean>;
}

export type BrokerEvent =
  | { type: "approval.created"; approval: ApprovalRequest }
  | {
      type: "approval.decided" | "approval.expired" | "approval.invalidated";
      approval: ApprovalRequest;
    }
  | { type: "grant.created" | "grant.used" | "grant.revoked"; grant: Grant }
  | { type: "receipt.created"; receipt: Receipt }
  | { type: "task.paused" | "task.downgraded"; taskId: string; reason: string };

export interface PermissionBrokerOptions {
  approvers: ApproverDirectory;
  store?: PermissionStore;
  audit?: AuditLog;
  receipts?: Receipts;
  notifier?: Notifier;
  policy?: PolicyConfig;
  clock?: Clock;
  bootId?: string;
  hooks?: PolicyHook[];
  classifier?: ActionClassifier;
  localProject?: LocalProjectVerifier;
  psycheHome?: string;
  /** Gateway UI origins the agent may never act on (design-03, design-19). */
  gatewayOrigins?: string[];
  presence?: PresenceVerifier;
  /** Which approvals need a presence assertion once a verifier is configured. */
  presenceFor?: "authentication" | "device_only";
  ttlMs?: number;
  armDelayMs?: number;
  onEvent?: (event: BrokerEvent) => void;
  newId?: (prefix: string) => string;
  /** Records grant revocations outside the backup scope (design-26). */
  revocations?: RevocationLedger;
  /** The channel layer's view of its conversations; without it no reply authority is issued. */
  channelConversations?: ChannelConversationLookup;
  /**
   * Folder access the agent asks for (`folder_access`, security §3.5). `env` names the sensitive
   * roots a pick is refused under; `persist` stores an `always` grant (Settings → File access).
   * Without it a `folder_access` approval can only be denied.
   */
  folderAccess?: {
    env: () => FolderAccessEnv;
    persist: (entry: FolderGrantEntry) => Promise<void>;
  };
}

type GrantFields = { grantFields?: JsonObject };

/** Challenge a presence assertion signs (design-04). */
export function presenceChallenge(
  approvalId: string,
  bindingHash: string,
  answerToken: string,
): string {
  return sha256(`psyche.presence.v1|${approvalId}|${bindingHash}|${answerToken}`);
}

const isChat = (s: Surface) => s.includes(":");

function actorOf(by: DecidedBy, surface?: Surface): AuditEntryInput["actor"] {
  if ("deviceId" in by) {
    const s = surface ?? by.surface;
    return { type: "device", deviceId: by.deviceId, ...(s === undefined ? {} : { surface: s }) };
  }
  return { type: "channel", ...(surface === undefined ? {} : { surface }) };
}

function fail(code: ErrorCode, message: string, details?: unknown): never {
  throw new PsycheError(code, message, details === undefined ? {} : { details });
}

/**
 * The Permission Broker (architecture §4.6, security §3): the only component that can authorize a
 * side effect. Evaluation lives in `PolicyEngine`; this class owns approvals, grants, receipts,
 * delivery and the audit trail.
 */
/** Calls one batch approval may hold (docs/workflows/mail-and-meetings-2026.md §8.1). */
export const MAX_BATCH_CALLS = 100;
/** How long a minted child approval of an approved batch stays usable. */
export const BATCH_CHILD_TTL_MS = 10 * 60_000;

/** The id of a batch's child approval: deterministic, so no store has to remember it. */
export function batchChildId(batchApprovalId: string, index: number): string {
  return `${batchApprovalId}.${index}`;
}

export class PsychePermissionBroker implements PermissionBroker {
  readonly clock: Clock;
  readonly audit: AuditLog | undefined;
  readonly receipts: Receipts;
  readonly engine: PolicyEngine;
  readonly #store: PermissionStore;
  readonly #approvers: ApproverDirectory;
  readonly #notifier: Notifier | undefined;
  readonly #presence: PresenceVerifier | undefined;
  readonly #presenceFor: "authentication" | "device_only";
  readonly #armDelayMs: number;
  readonly #ttlMs: number | undefined;
  readonly #onEvent: ((e: BrokerEvent) => void) | undefined;
  readonly #newId: (prefix: string) => string;
  readonly #revocations: RevocationLedger | undefined;
  readonly #classifierId: string;
  #policy: CompiledPolicy;
  #bootId: string;
  readonly #listeners = new Set<(e: BrokerEvent) => void>();
  readonly #waiters = new Map<string, Set<(a: ApprovalRequest) => void>>();
  readonly #timers = new Map<string, () => void>();
  readonly #notifications = new Map<string, string>();
  readonly #tasks = new Map<string, TaskState>();
  readonly #recent = new Map<
    string,
    { call: PolicyCall; ctx: PolicyContext; binding: Binding; decision: PolicyDecision; at: number }
  >();
  readonly #answerTimes = new Map<string, number[]>();
  readonly #channelConversations: ChannelConversationLookup | undefined;
  readonly #replyTimes = new Map<string, number[]>();
  readonly #folderAccess: PermissionBrokerOptions["folderAccess"];
  /** thread → folders allowed for that conversation only; gone at `/new` and at a restart. */
  readonly #sessionFolders = new Map<string, FolderGrantEntry[]>();

  constructor(options: PermissionBrokerOptions) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.#store = options.store ?? new MemoryPermissionStore();
    this.#approvers = options.approvers;
    this.audit = options.audit;
    this.receipts =
      options.receipts ??
      new Receipts({
        clock: this.clock,
        ...(options.audit === undefined ? {} : { audit: options.audit }),
      });
    this.#notifier = options.notifier;
    this.#presence = options.presence;
    this.#presenceFor = options.presenceFor ?? "authentication";
    this.#armDelayMs = options.armDelayMs ?? APPROVAL_ARM_DELAY_MS;
    this.#ttlMs = options.ttlMs;
    this.#onEvent = options.onEvent;
    this.#revocations = options.revocations;
    this.#channelConversations = options.channelConversations;
    this.#folderAccess = options.folderAccess;
    const ulid = monotonicFactory();
    this.#newId = options.newId ?? ((prefix) => `${prefix}_${ulid(this.clock.now())}`);
    this.#bootId = options.bootId ?? this.#newId("boot");
    this.#policy = compilePolicy(options.policy ?? {});
    const classifier = options.classifier ?? new RulesClassifier();
    this.#classifierId = classifier.id;
    const gatewayOrigins = (
      options.gatewayOrigins ?? ["http://127.0.0.1:7979", "http://localhost:7979"]
    ).map((o) => safeOrigin(o) ?? o);
    this.engine = new PolicyEngine({
      policy: () => this.#policy,
      task: (ctx) => this.#task(ctx),
      peekTask: (ctx) => this.#tasks.get(taskKey(ctx)),
      sessionFolders: (threadId) => this.#sessionFolders.get(threadId) ?? [],
      matchGrant: (key, kind, se, ctx, origin) => this.#matchGrant(key, kind, se, ctx, origin),
      useGrant: (rec, hash) => this.#useGrant(rec, hash),
      hooks: options.hooks ?? [],
      classifier,
      localProject: options.localProject ?? DENY_ALL_LOOPBACK,
      psycheHome: options.psycheHome,
      gatewayOrigins,
      onClassified: (ctx, call, label, reason, breaker) =>
        this.#onClassified(ctx, call, label, reason, breaker),
    });
  }

  get bootId(): string {
    return this.#bootId;
  }

  get policy(): PolicyConfig {
    return this.#policy.config;
  }

  /** Takes effect on the next call (feature F5). Never reachable from a tool (security §3.9). */
  setPolicy(config: PolicyConfig): void {
    this.#policy = compilePolicy(config);
  }

  subscribe(listener: (e: BrokerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(e: BrokerEvent): void {
    for (const l of [this.#onEvent, ...this.#listeners]) {
      try {
        l?.(structuredClone(e));
      } catch {
        // listeners never break the broker
      }
    }
  }

  async #log(
    kind: string,
    actor: AuditEntryInput["actor"],
    subject: JsonObject,
    data: JsonObject,
  ): Promise<void> {
    await this.audit?.append({ kind, actor, subject, data });
  }

  #task(ctx: PolicyContext): TaskState {
    const key = taskKey(ctx);
    let s = this.#tasks.get(key);
    if (s === undefined) {
      s = newTaskState();
      this.#tasks.set(key, s);
    }
    return s;
  }

  #ttl() {
    const g = this.#policy.config.grants ?? {};
    return {
      task: (g.taskHours ?? 24) * HOUR,
      destructiveTask: (g.destructiveTaskHours ?? 8) * HOUR,
      site: (g.siteExpiryDays ?? 30) * DAY,
      sessionIdle: (g.sessionIdleHours ?? 12) * HOUR,
      sessionMax: (g.sessionMaxHours ?? 24) * HOUR,
      always: (g.alwaysExpiryDays ?? 90) * DAY,
      execHostAlways: (g.execHostAlwaysExpiryDays ?? 30) * DAY,
    };
  }

  #approvalTtl(): number {
    const m = this.#policy.config.approvals?.ttlMinutes;
    return this.#ttlMs ?? (m === undefined ? APPROVAL_TTL_MS : m * 60_000);
  }

  // ---- decide -------------------------------------------------------------------------------

  async decide(call: PolicyCall, ctx: PolicyContext): Promise<PolicyDecision> {
    this.#sweep();
    const { decision, binding } = await this.engine.evaluate(call, ctx);
    if (decision.decision === "ask" && binding !== undefined) {
      // Keyed by the binding alone, kept for twice the approval lifetime: requestApproval restores
      // the broker's floors (side-effect class, scopes, typed confirmation) from it (review #1).
      const key = binding.bindingHash;
      const now = this.clock.now();
      this.#recent.delete(key);
      this.#recent.set(key, {
        call: structuredClone(decision.call),
        ctx: structuredClone(ctx),
        binding,
        decision,
        at: now,
      });
      const horizon = now - 2 * this.#approvalTtl();
      for (const [k, v] of this.#recent) {
        if (v.at >= horizon && this.#recent.size <= 20_000) break;
        this.#recent.delete(k);
      }
    }
    await this.#log(
      "tool_call.decided",
      { type: "agent", runId: ctx.runId },
      {
        runId: ctx.runId,
        threadId: ctx.threadId,
        ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
        ...(call.toolCallId === undefined ? {} : { toolCallId: call.toolCallId }),
      },
      {
        tool: call.tool,
        kind: decision.approvalKind ?? call.kind ?? inferApprovalKind(call.tool),
        sideEffect: decision.sideEffect,
        decision: decision.decision,
        rule: decision.rule,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        ...(decision.bindingHash === undefined ? {} : { bindingHash: decision.bindingHash }),
        ...(decision.grantId === undefined ? {} : { grantId: decision.grantId }),
        paramsHash: call.paramsHash,
        ...(call.target === undefined ? {} : { target: call.target.value }),
        taint: ctx.taint,
        mode: ctx.permissionMode,
        trace: decision.trace,
      },
    );
    // A connector action the owner set to Deny is refused with a receipt naming the rule (#747),
    // so the refusal shows next to the other actions on that connector.
    if (decision.decision === "deny" && decision.rule.startsWith("connector:")) {
      await this.recordReceipt({
        kind: decision.rule.slice(decision.rule.indexOf("/") + 1),
        outcome: "failed",
        summary: `Refused ${call.tool}: ${decision.reason ?? "the connector matrix denies it"}`,
        taskId: ctx.taskId ?? null,
        toolCallId: call.toolCallId ?? null,
        payload: { rule: decision.rule, decision: "deny" },
      });
    }
    return decision;
  }

  /**
   * Dry-run `decide` (§4.4 pre-flight, #686): the same evaluation, with no side effect. It skips
   * the sweep, grant use, the classifier, the audit entry, the receipt and the recent-decision
   * cache, and it never writes the broker's Task state (the engine works on copies). Hooks still
   * run, as they do in `decide`, so they must be pure.
   */
  async preview(intents: ToolCallIntent[], ctx: PolicyContext): Promise<PreviewResult[]> {
    const dry: DryRun = { scratch: new Map() };
    const out: PreviewResult[] = [];
    for (const intent of intents) {
      const call = structuredClone(intent) as PolicyCall;
      const { decision } = await this.engine.evaluate(call, ctx, dry);
      const kind = decision.approvalKind;
      const deviceOnly =
        decision.decision === "ask" &&
        kind !== undefined &&
        isDeviceOnly(kind, decision.sideEffect, this.#policy.config.approvals?.deviceOnly);
      out.push({
        tool: call.tool,
        decision: deviceOnly ? "device-only" : decision.decision,
        rule: decision.rule,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        ...(kind === undefined || decision.decision !== "ask" ? {} : { approvalKind: kind }),
        ...(decision.scopesOffered === undefined || decision.decision !== "ask"
          ? {}
          : { scopesOffered: decision.scopesOffered }),
      });
    }
    return out;
  }

  async #onClassified(
    ctx: PolicyContext,
    call: PolicyCall,
    label: string,
    reason: string,
    breaker?: "pause" | "downgrade",
  ) {
    const subject = {
      runId: ctx.runId,
      ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
    };
    await this.#log("classifier.labeled", { type: "system" }, subject, {
      classifier: this.#classifierId,
      tool: call.tool,
      label,
      reason,
    });
    if (breaker === undefined) return;
    await this.#log("classifier.circuit_open", { type: "system" }, subject, { action: breaker });
    if (ctx.taskId === undefined) return;
    if (breaker === "downgrade") {
      this.#emit({
        type: "task.downgraded",
        taskId: ctx.taskId,
        reason: "three consecutive sensitive labels",
      });
      return;
    }
    this.#emit({ type: "task.paused", taskId: ctx.taskId, reason: "possible injection" });
    await this.#notifier
      ?.notify({
        kind: "task_failed",
        title: "Task paused: possible injection",
        body: "Two actions were labeled prohibited. Review the task before resuming it.",
        taskId: ctx.taskId,
        dedupeKey: `possible_injection:${ctx.taskId}`,
      })
      .catch(() => undefined);
  }

  // ---- grants matching ----------------------------------------------------------------------

  #matchGrant(
    grantKey: string,
    kind: ApprovalKind,
    se: SideEffect,
    ctx: PolicyContext,
    origin: string | undefined,
  ) {
    const now = this.clock.now();
    const allowed = allowedScopes(se, kind);
    for (const rec of this.#store.listGrants()) {
      const g = rec.grant;
      if (g.revokedAt != null || g.grantKey !== grantKey || g.kind !== kind) continue;
      if (g.expiresAt != null && Date.parse(g.expiresAt) <= now) continue;
      if (!allowed.includes(g.scope)) continue;
      if (SEVERITY[se] > SEVERITY[rec.meta.sideEffect]) continue;
      if (g.scope === "task" && (g.taskId == null || g.taskId !== ctx.taskId)) continue;
      if (
        g.scope === "session" &&
        (rec.meta.sessionId !== this.#bootId || rec.meta.threadId !== ctx.threadId)
      )
        continue;
      if (g.scope === "site" && kind !== "credential_fill" && rec.meta.origin !== origin) continue;
      if (rec.meta.maxUses !== null && g.useCount >= rec.meta.maxUses) continue;
      // Grants never cross requesters: the owner's do not cover a designated person, and theirs
      // do not cover the owner (security §9).
      if ((rec.meta.requesterId ?? null) !== requesterKey(ctx.requester)) continue;
      return rec;
    }
    return undefined;
  }

  #useGrant(rec: StoredGrant, bindingHash: string): StoredGrant {
    const now = this.clock.now();
    const next = structuredClone(rec);
    next.grant.useCount += 1;
    next.grant.lastUsedAt = new Date(now).toISOString();
    next.meta.lastUsedBindingHash = bindingHash;
    if (next.grant.scope === "session") {
      // Idle expiry renews on use but never past the absolute cap (design-28).
      const ttl = this.#ttl();
      const cap = Date.parse(next.grant.createdAt) + ttl.sessionMax;
      next.grant.expiresAt = new Date(Math.min(now + ttl.sessionIdle, cap)).toISOString();
    }
    this.#store.updateGrant(next);
    this.#emit({ type: "grant.used", grant: next.grant });
    void this.#log(
      "grant.used",
      { type: "system" },
      { grantId: next.grant.id },
      { useCount: next.grant.useCount, bindingHash },
    );
    return next;
  }

  // ---- approvals ----------------------------------------------------------------------------

  /**
   * One approval for a listed set of `write` calls (an `ActionProposal`; docs/workflows/
   * mail-and-meetings-2026.md §8.1). Each call is decided now, as the loop would decide it. The
   * batch is refused when any call is denied, when any call's effective side effect is above
   * `write` (after the broker's floors), or when any call is a send, a device-only or an
   * authentication kind. The approval binds the ordered list of the calls' own binding hashes,
   * offers `once` only, and on approval mints one approved child approval per call.
   */
  async requestBatch(input: PolicyBatchInput): Promise<IssuedApproval> {
    this.#sweep();
    if (input.children.length === 0 || input.children.length > MAX_BATCH_CALLS) {
      fail("invalid_params", `a batch holds 1 to ${MAX_BATCH_CALLS} calls`);
    }
    const children: BatchChild[] = [];
    // Per child: the live prep-note standing grant that covers it (security §3.4), and whether
    // the decision already used it. Taint is never exempted: a tainted call asks and is not covered.
    const byGrant: { grant: StoredGrant; used: boolean }[] = [];
    for (const [i, c] of input.children.entries()) {
      const d = await this.decide(c.call, input.context);
      const kind = d.approvalKind ?? c.call.kind ?? inferApprovalKind(c.call.tool);
      const at = `call ${i + 1} (${c.call.tool})`;
      const covering = this.#prepGrantFor(c.call, d);
      if (covering !== undefined) byGrant.push(covering);
      if (d.decision === "deny") {
        fail("policy_denied", `${at} is denied: ${d.reason ?? d.rule}`);
      }
      if (SEVERITY[d.sideEffect] > SEVERITY.write) {
        fail("policy_denied", `${at} is ${d.sideEffect}; a batch holds write actions only`);
      }
      if (
        kind === "send_email" ||
        kind === "batch" ||
        DEVICE_ONLY_KINDS.includes(kind) ||
        AUTH_KINDS.includes(kind)
      ) {
        fail("policy_denied", `${at} (${kind}) needs its own approval`);
      }
      children.push({
        call: structuredClone(d.call),
        kind,
        bindingHash:
          d.bindingHash ??
          c.call.bindingHash ??
          bindingHash(kind, { tool: c.call.tool, paramsHash: c.call.paramsHash }),
        grantKey: d.grantKey ?? c.call.grantKey ?? `${c.call.tool}|${c.call.target?.value ?? "*"}`,
        sideEffect: d.sideEffect,
        summary: sanitizeDisplay(c.summary).slice(0, 300),
      });
    }
    const hash = bindingHash("batch", { children: children.map((c) => c.bindingHash) });
    // Every call is a Prep-titled `notes_create`: the card may offer the narrow `always` grant
    // for prep notes, and a live grant that covers every call approves the batch without a card.
    const prepNotes = children.length > 0 && children.every((c) => this.#isPrepChild(c));
    const covered = prepNotes ? byGrant : [];
    const issued = this.#issue({
      kind: "batch",
      summary: input.title,
      details: {
        ...(input.details ?? {}),
        title: input.title,
        count: children.length,
        calls: children.map((c) => c.summary),
      },
      bindingHash: hash,
      grantKey: `batch|${hash}`,
      requestedBy: { ...input.requestedBy },
      sideEffect: "write",
      surfaces: input.surfaces,
      // A tainted batch is never offered `always`: taint overrides grants (§3.6), so it would not apply.
      scopesOffered: prepNotes && !input.context.taint ? ["once", "always"] : ["once"],
      taint: input.context.taint,
      ...(input.taintSources === undefined ? {} : { taintSources: input.taintSources }),
      ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      context: structuredClone(input.context),
      batch: { children },
    });
    if (prepNotes && covered.length === children.length) {
      for (const [i, c] of covered.entries()) {
        const child = children[i];
        if (c.used || child === undefined) continue;
        // Re-read: one grant may cover several calls, each counting its own use.
        this.#useGrant(this.#store.getGrant(c.grant.grant.id) ?? c.grant, child.bindingHash);
      }
      const first = covered[0];
      if (first !== undefined) return await this.#approveBatchByGrant(issued, first.grant);
    }
    await this.#afterIssue(issued.approval);
    return issued;
  }

  /** A batch child that is a Prep-titled `notes_create`, keyed by the connector's own class. */
  #isPrepChild(c: BatchChild): boolean {
    return isPrepNoteCall({ tool: c.call.tool, params: c.call.params, grantKey: c.grantKey });
  }

  /**
   * The live prep-note grant that already approved this call (a decision of `allow` under it), or
   * undefined. Taint is never exempted (security §3.6): a tainted batch decides `ask` and is not
   * covered. The caller uses the grant only when the whole batch is covered.
   */
  #prepGrantFor(
    call: PolicyCall,
    d: PolicyDecision,
  ): { grant: StoredGrant; used: boolean } | undefined {
    const grantKey = d.grantKey ?? call.grantKey;
    if (grantKey === undefined || !isPrepNoteCall({ ...call, grantKey })) return undefined;
    if (d.decision !== "allow") return undefined;
    const used = d.grantId === undefined ? undefined : this.#store.getGrant(d.grantId);
    return used === undefined ? undefined : { grant: used, used: true };
  }

  /**
   * The batch is approved by a standing grant: no card, no notification. It is recorded as
   * approved under that grant (`scopeGranted: always`, `grantId`) with one minted child per call,
   * exactly as an answered card would leave it.
   */
  async #approveBatchByGrant(issued: IssuedApproval, grant: StoredGrant): Promise<IssuedApproval> {
    const now = this.clock.now();
    const decided = this.#store.transaction(() => {
      const rec = this.#store.getApproval(issued.approval.id);
      if (rec === undefined) return undefined;
      const a = rec.approval;
      a.status = "approved";
      a.scopeGranted = "always";
      a.decidedBy = null;
      a.decidedAt = new Date(now).toISOString();
      a.grantId = grant.grant.id;
      for (const t of rec.tokens) t.usedAt = a.decidedAt;
      this.#mintBatchChildren(rec, null, now);
      this.#store.updateApproval(rec);
      return rec;
    });
    this.#timers.get(issued.approval.id)?.();
    this.#timers.delete(issued.approval.id);
    if (decided === undefined) return issued;
    const a = decided.approval;
    await this.#log(
      "approval.decided",
      { type: "system" },
      { approvalId: a.id },
      {
        decision: "allow",
        grantScope: "always",
        grantId: grant.grant.id,
        bindingHash: a.bindingHash,
        taint: a.taint,
        via: "grant",
      },
    );
    this.#settled(a, "approval.decided");
    return { approval: structuredClone(a), answerTokens: {} };
  }

  /**
   * The minted child approvals of an approved batch, in order, with the calls they cover.
   * Empty until the batch is approved (and for any other kind).
   */
  async batchChildren(
    batchApprovalId: string,
  ): Promise<{ approval: ApprovalRequest; call: PolicyCall; summary: string }[]> {
    this.#sweep();
    const rec = this.#store.getApproval(batchApprovalId);
    if (rec === undefined || rec.approval.kind !== "batch" || rec.approval.status !== "approved") {
      return [];
    }
    const out: { approval: ApprovalRequest; call: PolicyCall; summary: string }[] = [];
    for (const [i, c] of (rec.input.batch?.children ?? []).entries()) {
      const child = this.#store.getApproval(batchChildId(batchApprovalId, i));
      if (child === undefined) continue;
      out.push({
        approval: structuredClone(child.approval),
        call: structuredClone(c.call),
        summary: c.summary,
      });
    }
    return out;
  }

  #mintBatchChildren(batch: StoredApproval, by: DecidedBy | null, now: number): void {
    const children = batch.input.batch?.children ?? [];
    const at = new Date(now).toISOString();
    const expiresAt = new Date(now + BATCH_CHILD_TTL_MS).toISOString();
    for (const [i, c] of children.entries()) {
      const approval: ApprovalRequest = {
        id: batchChildId(batch.approval.id, i),
        kind: c.kind,
        summary: c.summary,
        details: { batchApprovalId: batch.approval.id, index: i, tool: c.call.tool },
        bindingHash: c.bindingHash,
        grantKey: c.grantKey,
        requestedBy: {
          ...batch.approval.requestedBy,
          toolCallId: `${batch.approval.id}:${i}`,
        },
        surfaces: [],
        scopesOffered: ["once"],
        deviceOnly: false,
        requiresAuthentication: false,
        taint: batch.approval.taint,
        status: "approved",
        scopeGranted: "once",
        decidedBy: by === null ? null : structuredClone(by),
        requestedAt: at,
        expiresAt,
        decidedAt: at,
        grantId: null,
      };
      approval.sideEffect = c.sideEffect;
      if (batch.approval.taintSources !== undefined) {
        approval.taintSources = structuredClone(batch.approval.taintSources);
      }
      this.#store.insertApproval({
        approval,
        tokens: [],
        input: {
          kind: c.kind,
          summary: c.summary,
          details: approval.details,
          bindingHash: c.bindingHash,
          grantKey: c.grantKey,
          requestedBy: approval.requestedBy,
          sideEffect: c.sideEffect,
          surfaces: [],
          taint: approval.taint,
          call: structuredClone(c.call),
          ...(batch.input.context === undefined ? {} : { context: batch.input.context }),
        },
        consumedAt: null,
        revoked: false,
        bootId: this.#bootId,
      });
    }
  }

  async requestApproval(input: PolicyApprovalInput): Promise<IssuedApproval> {
    this.#sweep();
    const issued = this.#issue(input);
    await this.#afterIssue(issued.approval);
    return issued;
  }

  #issue(raw: PolicyApprovalInput): IssuedApproval {
    const now = this.clock.now();
    const input: PolicyApprovalInput & GrantFields = structuredClone(raw);
    const recent = this.#recent.get(input.bindingHash);
    if (recent !== undefined) {
      input.call ??= recent.call;
      input.context ??= recent.ctx;
      if (recent.decision.typedConfirmation !== undefined)
        input.typedConfirmation ??= recent.decision.typedConfirmation;
      if (recent.binding.grantKey === input.grantKey)
        input.grantFields ??= recent.binding.grantFields;
      // The broker's own side-effect floor wins over a lower declared class.
      if (SEVERITY[recent.decision.sideEffect] > SEVERITY[input.sideEffect])
        input.sideEffect = recent.decision.sideEffect;
    }
    const se = input.sideEffect;
    const deviceOnly = isDeviceOnly(input.kind, se, this.#policy.config.approvals?.deviceOnly);
    const requiresAuthentication = AUTH_KINDS.includes(input.kind) || se === "financial";
    // A non-owner requester never sees the card for their own request (security §9).
    const requester = input.context?.requester;
    const own = new Set(requesterSurfaces(requester));
    let surfaces = [
      ...new Set(
        (deviceOnly ? input.surfaces.filter((s) => !isChat(s)) : input.surfaces).filter(
          (s) => !own.has(s),
        ),
      ),
    ];
    if (surfaces.length === 0) surfaces = ["desktop"];

    const allowed = allowedScopes(se, input.kind);
    const fromDecision = recent?.decision.scopesOffered;
    let scopesOffered = [...new Set(input.scopesOffered ?? fromDecision ?? allowed)].filter(
      (s) =>
        allowed.includes(s) &&
        (fromDecision === undefined || fromDecision.includes(s)) &&
        (s !== "task" || input.requestedBy.taskId != null) &&
        (s !== "session" || input.requestedBy.threadId != null),
    );
    if (input.typedConfirmation !== undefined)
      scopesOffered = scopesOffered.filter((s) => s === "once");
    // Taint always overrides standing grants (§3.6): a tainted folder request is never kept.
    if (input.kind === "folder_access" && (input.taint || input.context?.taint === true))
      scopesOffered = scopesOffered.filter((s) => s === "once");
    if (scopesOffered.length === 0) scopesOffered = ["once"];

    const details = sanitizeDetails(input.details) as JsonObject;
    if (input.typedConfirmation !== undefined) details.confirmationWord = input.typedConfirmation;
    if (requester !== undefined && requester.role !== "owner") {
      details.requestedFor = sanitizeDisplay(
        `${requester.role}: ${requester.display ?? requester.identityId ?? requester.senderId ?? "unknown"}`,
      );
    }
    const sources = input.taintSources ?? input.context?.taintSources;
    if (sources !== undefined && sources.length > 0) {
      details.taintSources = sources.map((s) =>
        sanitizeDisplay(`${s.sourceKind}:${s.origin ?? s.sender ?? "?"}`),
      );
    }
    const approval: ApprovalRequest = {
      id: this.#newId("apr"),
      kind: input.kind,
      summary: sanitizeDisplay(input.summary),
      details,
      bindingHash: input.bindingHash,
      grantKey: input.grantKey,
      requestedBy: { ...input.requestedBy },
      surfaces,
      scopesOffered,
      deviceOnly,
      requiresAuthentication,
      taint: input.taint || input.context?.taint === true,
      status: "pending",
      scopeGranted: null,
      decidedBy: null,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (input.ttlMs ?? this.#approvalTtl())).toISOString(),
      decidedAt: null,
      grantId: null,
    };
    approval.sideEffect = se;
    if (approval.taint && sources !== undefined && sources.length > 0) {
      approval.taintSources = sources.map((s) => {
        const out: TaintSource = { sourceKind: sanitizeDisplay(s.sourceKind) };
        if (s.origin !== undefined) out.origin = sanitizeDisplay(s.origin);
        if (s.sender !== undefined) out.sender = sanitizeDisplay(s.sender);
        if (s.toolCallId !== undefined) out.toolCallId = s.toolCallId;
        return out;
      });
    }
    if (input.targetKind !== undefined) approval.targetKind = input.targetKind;
    if (input.target !== undefined) approval.target = { ...input.target };
    if (input.fromLesson !== undefined) {
      approval.fromLesson = {
        lessonId: input.fromLesson.lessonId,
        feedbackId: input.fromLesson.feedbackId,
        because: sanitizeDisplay(input.fromLesson.because).slice(0, 500),
      };
    }
    const answerTokens: Record<Surface, string> = {};
    const tokens = surfaces.map((surface) => {
      const token = `at_${randomBytes(24).toString("base64url")}`;
      answerTokens[surface] = token;
      return { surface, hash: sha256(token), usedAt: null };
    });
    this.#store.insertApproval({
      approval,
      tokens,
      input,
      consumedAt: null,
      revoked: false,
      bootId: this.#bootId,
    });
    this.#armExpiry(approval);
    return { approval: structuredClone(approval), answerTokens };
  }

  async #afterIssue(a: ApprovalRequest): Promise<void> {
    this.#emit({ type: "approval.created", approval: a });
    await this.#log(
      "approval.created",
      { type: "system" },
      {
        approvalId: a.id,
        ...(a.requestedBy.taskId == null ? {} : { taskId: a.requestedBy.taskId }),
        ...(a.requestedBy.toolCallId === undefined ? {} : { toolCallId: a.requestedBy.toolCallId }),
      },
      {
        kind: a.kind,
        sideEffect: a.sideEffect ?? null,
        bindingHash: a.bindingHash,
        surfaces: a.surfaces,
        scopesOffered: a.scopesOffered,
        deviceOnly: a.deviceOnly,
        taint: a.taint,
        expiresAt: a.expiresAt,
      },
    );
    if (this.#notifier === undefined) return;
    try {
      const n = await this.#notifier.notify({
        kind: "approval",
        title: cardHeader(a),
        // Header only: the card holds the details (design-12). Tokens never go through the inbox.
        body: "Approval pending",
        approvalId: a.id,
        ...(a.requestedBy.taskId == null ? {} : { taskId: a.requestedBy.taskId }),
        surfaces: a.surfaces,
        dedupeKey: `approval:${a.id}`,
        route: `/approvals/${a.id}`,
      });
      this.#notifications.set(a.id, n.id);
    } catch {
      // Delivery failure leaves the request pending in the approvals queue.
    }
  }

  #armExpiry(a: ApprovalRequest): void {
    const at = Date.parse(a.expiresAt);
    const c = this.clock as Clock & { setTimer?: (at: number, fn: () => void) => () => void };
    if (typeof c.setTimer === "function") {
      this.#timers.set(
        a.id,
        c.setTimer.call(this.clock, at, () => this.#sweep()),
      );
      return;
    }
    const t = setTimeout(() => this.#sweep(), Math.max(0, at - this.clock.now()));
    t.unref?.();
    this.#timers.set(a.id, () => clearTimeout(t));
  }

  #rateLimited(identity: string): boolean {
    const limit = this.#policy.config.approvals?.answersPerMinute ?? 10;
    const now = this.clock.now();
    const times = (this.#answerTimes.get(identity) ?? []).filter((t) => t > now - 60_000);
    times.push(now);
    this.#answerTimes.set(identity, times);
    return times.length > limit;
  }

  async #reject(
    rec: StoredApproval | undefined,
    id: string,
    by: DecidedBy,
    reason: string,
    code: ErrorCode,
    message: string,
    details?: unknown,
  ): Promise<never> {
    await this.#log(
      "approval.answer_rejected",
      actorOf(by),
      {
        approvalId: id,
        ...(rec?.approval.requestedBy.taskId == null
          ? {}
          : { taskId: rec.approval.requestedBy.taskId }),
      },
      { reason, status: rec?.approval.status ?? "unknown" },
    );
    return fail(code, message, details);
  }

  async answer(input: PolicyAnswerInput): Promise<ApprovalRequest> {
    this.#sweep();
    const by = input.decidedBy;
    const identity =
      "deviceId" in by ? `device:${by.deviceId}` : `channel:${by.channel}:${by.senderId}`;
    const id = input.approvalId;
    if (this.#rateLimited(identity))
      return this.#reject(undefined, id, by, "rate_limited", "rate_limited", "too many answers");
    const rec = this.#store.getApproval(id);
    if (rec === undefined)
      return this.#reject(undefined, id, by, "not_found", "not_found", `approval ${id} not found`);
    const a = rec.approval;
    if (a.status === "pending" && rec.bootId !== this.#bootId) {
      // Issued by an earlier Gateway boot and not yet re-issued (review #14).
      return this.#reject(
        rec,
        id,
        by,
        "invalidated",
        "approval_invalidated",
        "approval invalidated (re-issued)",
        {
          reason: "re-issued",
        },
      );
    }
    if (a.status === "expired")
      return this.#reject(rec, id, by, "late", "approval_expired", "approval expired", {
        late: true,
      });
    if (a.status === "invalidated") {
      const r =
        a.invalidatedReason === "gateway_restart"
          ? "re-issued"
          : (a.invalidatedReason ?? "invalidated");
      return this.#reject(
        rec,
        id,
        by,
        "invalidated",
        "approval_invalidated",
        `approval invalidated (${r})`,
        { reason: r },
      );
    }
    const tokenHash = sha256(input.answerToken);
    const token = rec.tokens.find((t) => t.hash === tokenHash);
    if (token === undefined)
      return this.#reject(rec, id, by, "unknown_token", "forbidden", "unknown answer token");
    if (token.usedAt !== null)
      return this.#reject(rec, id, by, "replayed", "answer_replayed", "answer token already used");
    if (a.status !== "pending")
      return this.#reject(rec, id, by, "late", "answer_late", `approval already ${a.status}`);
    if (this.clock.now() < Date.parse(a.requestedAt) + this.#armDelayMs) {
      return this.#reject(
        rec,
        id,
        by,
        "not_armed",
        "approval_not_armed",
        "approval card is not armed yet",
      );
    }

    // The answerer must match the token's surface and be an approver (security §3.7, design-20).
    const chat = isChat(token.surface);
    if (chat) {
      if (!("channel" in by) || token.surface.split(":")[0] !== by.channel) {
        return this.#reject(
          rec,
          id,
          by,
          "surface_mismatch",
          "forbidden",
          "a chat token is answered from that chat",
        );
      }
      if (a.deviceOnly)
        return this.#reject(
          rec,
          id,
          by,
          "device_only",
          "forbidden",
          "device-only approvals cannot be answered from chat",
        );
      if (!(await this.#approvers.isOwnerSender(by.channel, by.senderId))) {
        return this.#reject(
          rec,
          id,
          by,
          "not_owner",
          "forbidden",
          "only the owner's identity answers approvals",
        );
      }
    } else {
      if (!("deviceId" in by))
        return this.#reject(
          rec,
          id,
          by,
          "surface_mismatch",
          "forbidden",
          "a device token is answered by a device",
        );
      if (by.surface !== undefined && by.surface !== token.surface) {
        return this.#reject(
          rec,
          id,
          by,
          "surface_mismatch",
          "forbidden",
          "the answer came from another surface",
        );
      }
      const device = await this.#approvers.device(by.deviceId);
      if (
        device === undefined ||
        device.revoked === true ||
        device.role === "node" ||
        !device.scopes.includes("operator.approvals")
      ) {
        return this.#reject(
          rec,
          id,
          by,
          "not_approver",
          "forbidden",
          "the device lacks operator.approvals",
        );
      }
    }

    const scope: GrantScope = input.scope ?? "once";
    if (input.decision === "approve") {
      if (!a.scopesOffered.includes(scope))
        return this.#reject(
          rec,
          id,
          by,
          "scope_not_offered",
          "invalid_params",
          `scope ${scope} not offered`,
        );
      const chatScopes = this.#policy.config.approvals?.chatScopes ?? ["once"];
      if (chat && !chatScopes.includes(scope)) {
        return this.#reject(
          rec,
          id,
          by,
          "chat_scope",
          "invalid_params",
          `chat answers ${chatScopes.join(" / ")} only`,
        );
      }
      const word = rec.input.typedConfirmation;
      if (word !== undefined && input.typedConfirmation !== word) {
        return this.#reject(
          rec,
          id,
          by,
          "confirmation_missing",
          "invalid_params",
          `type ${word} to confirm`,
        );
      }
      const needsPresence =
        this.#presenceFor === "device_only"
          ? a.deviceOnly || a.requiresAuthentication
          : a.requiresAuthentication;
      if (this.#presence !== undefined && needsPresence) {
        if (
          input.presence === undefined ||
          !("deviceId" in by) ||
          input.presence.deviceId !== by.deviceId
        ) {
          return this.#reject(
            rec,
            id,
            by,
            "presence_required",
            "forbidden",
            "a presence assertion is required",
            { reason: "presence_required" },
          );
        }
        const ok = await this.#presence.verify(
          input.presence,
          presenceChallenge(a.id, a.bindingHash, input.answerToken),
          by.deviceId,
        );
        if (!ok)
          return this.#reject(
            rec,
            id,
            by,
            "presence_invalid",
            "forbidden",
            "presence assertion invalid",
            { reason: "presence_invalid" },
          );
      }
    }

    // The folder the owner picked is what is granted, never the agent's string (security §3.5).
    let folderPick: FolderGrantEntry | undefined;
    if (input.decision === "approve" && a.kind === "folder_access") {
      if (this.#folderAccess === undefined || input.folderPath === undefined) {
        return this.#reject(
          rec,
          id,
          by,
          "folder_missing",
          "invalid_params",
          "pick the folder to share",
        );
      }
      if (scope === "once" && a.requestedBy.threadId == null) {
        return this.#reject(
          rec,
          id,
          by,
          "folder_no_thread",
          "invalid_params",
          "this request has no conversation",
        );
      }
      try {
        folderPick = {
          path: await resolveFolderPick(input.folderPath, this.#folderAccess.env()),
          mode: a.details.access === "rw" ? "rw" : "ro",
        };
      } catch (err) {
        await this.#log(
          "approval.answer_rejected",
          actorOf(by),
          { approvalId: id },
          {
            reason: "folder_refused",
            status: a.status,
          },
        );
        throw err;
      }
    }

    // First authorized answer wins: re-read, check, mark the token and decide atomically.
    // Re-read the clock after the awaited approver and presence checks (review #14).
    const now = this.clock.now();
    let grant: StoredGrant | undefined;
    const decided = this.#store.transaction(() => {
      const fresh = this.#store.getApproval(id);
      if (fresh === undefined) return undefined;
      if (fresh.approval.status === "expired" || now >= Date.parse(fresh.approval.expiresAt)) {
        return "expired" as const;
      }
      if (fresh.approval.status !== "pending") return undefined;
      const t = fresh.tokens.find((x) => x.hash === tokenHash);
      if (t === undefined || t.usedAt !== null) return undefined;
      t.usedAt = new Date(now).toISOString();
      const fa = fresh.approval;
      fa.decidedBy = structuredClone(by);
      fa.decidedAt = new Date(now).toISOString();
      if (input.decision === "deny") fa.status = "denied";
      else {
        fa.status = "approved";
        fa.scopeGranted = scope;
        // A batch becomes one approved, once-only approval per listed call (§8.1).
        if (fa.kind === "batch") this.#mintBatchChildren(fresh, by, now);
        if (fa.kind === "folder_access" && folderPick !== undefined) {
          // Not a ledger grant: `always` lives in Settings → File access, `once` in the thread.
          fa.details = { ...fa.details, granted: { ...folderPick } };
        } else if (fa.kind === "batch" && scope === "always") {
          // The one batch grant: prep notes only. It binds the calls' own key, not the batch's.
          grant = this.#newPrepNoteGrant(fresh, by, now);
          if (grant === undefined) fa.scopeGranted = "once";
          else {
            this.#store.insertGrant(grant);
            fa.grantId = grant.grant.id;
          }
        } else if (scope !== "once") {
          grant = this.#newGrant(fresh, scope, by, now);
          this.#store.insertGrant(grant);
          fa.grantId = grant.grant.id;
        }
      }
      this.#store.updateApproval(fresh);
      return fresh;
    });
    if (decided === "expired") {
      this.#sweep();
      return this.#reject(rec, id, by, "late", "approval_expired", "approval expired", {
        late: true,
      });
    }
    if (decided === undefined)
      return this.#reject(rec, id, by, "late", "answer_late", "approval was answered concurrently");
    this.#timers.get(id)?.();
    this.#timers.delete(id);
    const fa = decided.approval;
    if (fa.status === "approved" && folderPick !== undefined) {
      await this.#applyFolder(fa, folderPick, scope, by);
    }
    const { call, context } = decided.input;
    if (fa.status === "approved" && call !== undefined && context !== undefined) {
      const tk = targetKey(call);
      if (tk !== undefined) {
        const st = this.#task(context);
        st.approvedTargets.add(tk);
        st.touched.add(tk);
      }
    }
    await this.#log(
      "approval.decided",
      { ...actorOf(by, token.surface), ...(chat ? {} : { scope: "operator.approvals" }) },
      {
        approvalId: fa.id,
        ...(fa.requestedBy.taskId == null ? {} : { taskId: fa.requestedBy.taskId }),
        ...(fa.requestedBy.toolCallId === undefined
          ? {}
          : { toolCallId: fa.requestedBy.toolCallId }),
      },
      {
        decision: input.decision === "approve" ? "allow" : "deny",
        grantScope: fa.scopeGranted,
        bindingHash: fa.bindingHash,
        taint: fa.taint,
        latencyMs: now - Date.parse(fa.requestedAt),
        // Answered by a spoken phrase after a readback (voice conversation, §4.6).
        ...(input.via === "voice" ? { via: "voice" } : {}),
      },
    );
    const g = grant as StoredGrant | undefined;
    if (g !== undefined) {
      this.#emit({ type: "grant.created", grant: g.grant });
      await this.#log(
        "grant.created",
        actorOf(by),
        { grantId: g.grant.id, approvalId: fa.id },
        {
          kind: g.grant.kind,
          scope: g.grant.scope,
          grantKey: g.grant.grantKey,
          expiresAt: g.grant.expiresAt,
        },
      );
    }
    this.#settled(fa, "approval.decided");
    return structuredClone(fa);
  }

  /** Makes an approved pick usable now: this conversation's roots, or Settings for `always`. */
  async #applyFolder(
    fa: ApprovalRequest,
    pick: FolderGrantEntry,
    scope: GrantScope,
    by: DecidedBy,
  ): Promise<void> {
    const threadId = fa.requestedBy.threadId;
    let kept: GrantScope = scope;
    if (scope === "always") {
      try {
        await this.#folderAccess?.persist(pick);
      } catch {
        // Not stored: the folder still works for this conversation, and the record says so.
        kept = "once";
        await this.#log("folder.persist_failed", actorOf(by), { approvalId: fa.id }, { ...pick });
      }
    }
    if (kept === "once" && threadId != null) {
      const roots = this.#sessionFolders.get(threadId) ?? [];
      this.#sessionFolders.set(threadId, [...roots.filter((r) => r.path !== pick.path), pick]);
    }
    await this.#log(
      "folder.granted",
      actorOf(by),
      { approvalId: fa.id, ...(threadId == null ? {} : { threadId }) },
      { path: pick.path, mode: pick.mode, scope: kept, taint: fa.taint },
    );
  }

  /** Folders allowed for one conversation (`once`), for the file executors behind the broker. */
  sessionFolders(threadId: string): readonly FolderGrantEntry[] {
    return this.#sessionFolders.get(threadId) ?? [];
  }

  /**
   * The `always` grant of an approved prep-note batch (security §3.4, §3.5): the calls' own
   * grant key (`notes_create` with a `Prep:` title), `createdFrom` the batch approval, 90 days.
   * Undefined unless every call is a Prep-titled `notes_create` under one key.
   */
  #newPrepNoteGrant(rec: StoredApproval, by: DecidedBy, now: number): StoredGrant | undefined {
    const a = rec.approval;
    const children = rec.input.batch?.children ?? [];
    const first = children[0];
    if (first === undefined) return undefined;
    if (!children.every((c) => this.#isPrepChild(c) && c.grantKey === first.grantKey)) {
      return undefined;
    }
    const target = first.call.target;
    return {
      grant: {
        id: this.#newId("grt"),
        kind: first.kind,
        scope: "always",
        grantKey: first.grantKey,
        subject: {
          grantKey: first.grantKey,
          tool: first.call.tool,
          titlePrefix: PREP_NOTE_TITLE_PREFIX,
          ...(target === undefined ? {} : { target }),
          sideEffect: "write",
        },
        binding: { bindingHash: first.bindingHash },
        expiresAt: new Date(now + this.#ttl().always).toISOString(),
        useCount: 0,
        lastUsedAt: null,
        createdFromApprovalId: a.id,
        taskId: null,
        createdAt: new Date(now).toISOString(),
        revokedAt: null,
      },
      meta: {
        sideEffect: "write",
        sessionId: null,
        threadId: null,
        origin: null,
        createdByDeviceId: "deviceId" in by ? by.deviceId : null,
        maxUses: null,
        lastUsedBindingHash: null,
        revokedReason: null,
        requesterId: requesterKey(rec.input.context?.requester),
      },
    };
  }

  #newGrant(
    rec: StoredApproval,
    scope: Exclude<GrantScope, "once">,
    by: DecidedBy,
    now: number,
  ): StoredGrant {
    const a = rec.approval;
    const ttl = this.#ttl();
    const se = a.sideEffect ?? rec.input.sideEffect;
    const life =
      scope === "task"
        ? se === "destructive"
          ? Math.min(ttl.destructiveTask, ttl.task)
          : ttl.task
        : scope === "site"
          ? ttl.site
          : scope === "session"
            ? Math.min(ttl.sessionIdle, ttl.sessionMax)
            : a.kind === "exec_host"
              ? ttl.execHostAlways
              : ttl.always;
    const grantFields = (rec.input as GrantFields).grantFields;
    const origin = a.target?.kind === "origin" ? (safeOrigin(a.target.value) ?? null) : null;
    return {
      grant: {
        id: this.#newId("grt"),
        kind: a.kind,
        scope,
        grantKey: a.grantKey,
        subject: {
          grantKey: a.grantKey,
          ...(grantFields ?? {}),
          ...(a.target === undefined ? {} : { target: a.target }),
          sideEffect: se,
        },
        binding: { bindingHash: a.bindingHash },
        expiresAt: new Date(now + life).toISOString(),
        useCount: 0,
        lastUsedAt: null,
        createdFromApprovalId: a.id,
        taskId: scope === "task" ? (a.requestedBy.taskId ?? null) : null,
        createdAt: new Date(now).toISOString(),
        revokedAt: null,
      },
      meta: {
        sideEffect: se,
        sessionId: scope === "session" ? this.#bootId : null,
        threadId: scope === "session" ? (a.requestedBy.threadId ?? null) : null,
        origin: scope === "site" ? origin : null,
        createdByDeviceId: "deviceId" in by ? by.deviceId : null,
        maxUses: null,
        lastUsedBindingHash: null,
        revokedReason: null,
        requesterId: requesterKey(rec.input.context?.requester),
      },
    };
  }

  #settled(
    a: ApprovalRequest,
    type: "approval.decided" | "approval.expired" | "approval.invalidated",
  ): void {
    this.#emit({ type, approval: a });
    const nid = this.#notifications.get(a.id);
    if (nid !== undefined) {
      this.#notifications.delete(a.id);
      this.#notifier?.resolve(nid).catch(() => undefined);
    }
    const set = this.#waiters.get(a.id);
    if (set === undefined) return;
    this.#waiters.delete(a.id);
    for (const w of set) w(structuredClone(a));
  }

  awaitDecision(approvalId: string, signal?: AbortSignal): Promise<ApprovalRequest> {
    this.#sweep();
    const rec = this.#store.getApproval(approvalId);
    if (rec === undefined)
      return Promise.reject(new PsycheError("not_found", "approval not found"));
    if (rec.approval.status !== "pending") return Promise.resolve(rec.approval);
    return new Promise((resolve, reject) => {
      const set = this.#waiters.get(approvalId) ?? new Set();
      const onAbort = () => {
        set.delete(waiter);
        reject(new PsycheError("cancelled", "awaitDecision aborted"));
      };
      const waiter = (a: ApprovalRequest) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(a);
      };
      if (signal?.aborted === true) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      set.add(waiter);
      this.#waiters.set(approvalId, set);
    });
  }

  async verifyBinding(approvalId: string, bindingHash: string): Promise<BindingVerification> {
    this.#sweep();
    const now = this.clock.now();
    const result = this.#store.transaction((): BindingVerification => {
      const rec = this.#store.getApproval(approvalId);
      if (rec === undefined) return { ok: false, reason: "not_found" };
      const a = rec.approval;
      if (rec.revoked || a.status === "invalidated") return { ok: false, reason: "revoked" };
      if (a.status === "expired") return { ok: false, reason: "expired" };
      if (a.status !== "approved") return { ok: false, reason: "not_approved" };
      if (a.grantId != null) {
        const g = this.#store.getGrant(a.grantId);
        if (g === undefined || g.grant.revokedAt != null) return { ok: false, reason: "revoked" };
        if (g.grant.expiresAt != null && now >= Date.parse(g.grant.expiresAt))
          return { ok: false, reason: "expired" };
        if (g.meta.maxUses !== null && g.grant.useCount >= g.meta.maxUses)
          return { ok: false, reason: "consumed" };
      }
      if (bindingHash !== a.bindingHash) return { ok: false, reason: "binding_mismatch" };
      if (a.scopeGranted === "once") {
        if (rec.consumedAt !== null) return { ok: false, reason: "consumed" };
        if (now >= Date.parse(a.expiresAt)) return { ok: false, reason: "expired" };
        rec.consumedAt = new Date(now).toISOString();
        this.#store.updateApproval(rec);
      }
      return { ok: true, approval: structuredClone(a) };
    });
    const rec = this.#store.getApproval(approvalId);
    await this.#log(
      result.ok ? "binding.verified" : "binding.mismatch",
      { type: "system" },
      {
        approvalId,
        ...(rec?.approval.requestedBy.taskId == null
          ? {}
          : { taskId: rec.approval.requestedBy.taskId }),
      },
      result.ok
        ? { bindingHash }
        : {
            reason: result.reason,
            expected: rec?.approval.bindingHash ?? null,
            actual: bindingHash,
          },
    );
    return result;
  }

  async get(approvalId: string): Promise<ApprovalRequest | undefined> {
    this.#sweep();
    return this.#store.getApproval(approvalId)?.approval;
  }

  async list(filter: { status?: ApprovalStatus } = {}): Promise<ApprovalRequest[]> {
    this.#sweep();
    return this.#store.listApprovals(filter).map((r) => r.approval);
  }

  /**
   * Gateway boot (security §3.7 "Restart", design-09, design-28): invalidate every pending request,
   * revoke `session` grants of earlier boots, re-evaluate each parked call with its persisted
   * context (taint included) and issue a fresh request. A re-issued request never auto-allows.
   */
  async reissue(): Promise<IssuedApproval[]> {
    this.#sweep();
    this.#bootId = this.#newId("boot");
    const pending = this.#store.listApprovals({ status: "pending" });
    for (const rec of pending) await this.#invalidate(rec, "gateway_restart");
    // An approved `once` that was never dispatched belonged to a call parked in the previous
    // process; that call is gone, so the approval ends too (S23 design-09). Found by fuzzing.
    for (const rec of this.#store.listApprovals({ status: "approved" })) {
      if (rec.approval.scopeGranted !== "once" || rec.consumedAt !== null || rec.revoked) continue;
      rec.revoked = true;
      this.#store.updateApproval(rec);
      await this.#log(
        "approval.invalidated",
        { type: "system" },
        { approvalId: rec.approval.id },
        { reason: "gateway_restart_unconsumed" },
      );
    }
    for (const g of this.#store.listGrants()) {
      if (
        g.grant.scope === "session" &&
        g.grant.revokedAt == null &&
        g.meta.sessionId !== this.#bootId
      ) {
        await this.#revoke(g, "gateway_restart");
      }
    }
    const issued: IssuedApproval[] = [];
    for (const rec of pending) {
      const input = structuredClone(rec.input);
      input.taint = input.taint || rec.approval.taint;
      if (input.call !== undefined && input.context !== undefined) {
        const ctx = { ...input.context, taint: input.context.taint || rec.approval.taint };
        const { decision } = await this.engine.evaluate(input.call, ctx);
        if (decision.decision === "deny") {
          await this.#log(
            "approval.invalidated",
            { type: "system" },
            { approvalId: rec.approval.id },
            { reason: "denied_on_reissue", rule: decision.rule },
          );
          continue;
        }
        // Equal or stricter: only scopes both evaluations allow.
        const prev = rec.approval.scopesOffered;
        input.scopesOffered = (decision.scopesOffered ?? prev).filter((s) => prev.includes(s));
        input.context = ctx;
      } else {
        input.scopesOffered = rec.approval.scopesOffered;
      }
      const next = this.#issue(input);
      await this.#afterIssue(next.approval);
      issued.push(next);
    }
    return issued;
  }

  async #invalidate(rec: StoredApproval, reason: string): Promise<void> {
    const a = rec.approval;
    a.status = "invalidated";
    a.invalidatedReason = reason;
    this.#store.updateApproval(rec);
    this.#timers.get(a.id)?.();
    this.#timers.delete(a.id);
    await this.#log("approval.invalidated", { type: "system" }, { approvalId: a.id }, { reason });
    this.#settled(a, "approval.invalidated");
  }

  #sweep(): void {
    const now = this.clock.now();
    for (const rec of this.#store.listApprovals({ status: "pending" })) {
      const a = rec.approval;
      if (now < Date.parse(a.expiresAt)) continue;
      a.status = "expired";
      this.#store.updateApproval(rec);
      this.#timers.delete(a.id);
      void this.#log(
        "approval.expired",
        { type: "system" },
        { approvalId: a.id },
        { expiresAt: a.expiresAt },
      );
      this.#settled(a, "approval.expired");
    }
  }

  /**
   * A system-decided `message_send` approval (scope `once`, `decidedBy {channel, senderId}`) for
   * one channel send into a conversation the channel's policy lets Psyche answer: a reply to the
   * routed sender who just wrote there, a pairing code to an unknown sender who just wrote, or an
   * approval card into the owner's own direct conversation. Refuses (`forbidden`) otherwise.
   * Never shown as a card; every issue and refusal is audited.
   */
  async authorizeChannelReply(input: ChannelReplyInput): Promise<ApprovalRequest> {
    this.#sweep();
    const { turn } = input;
    const subject = {
      channel: input.channel,
      account: input.account,
      ...(turn === undefined ? {} : { runId: turn.context.runId, threadId: turn.context.threadId }),
    };
    const refuse = async (reason: string, message: string, rule?: string): Promise<never> => {
      await this.#log("approval.channel_reply_refused", { type: "system" }, subject, {
        reason,
        purpose: input.purpose,
        ...(rule === undefined ? {} : { rule }),
        ...(turn === undefined ? {} : { taint: turn.context.taint }),
      });
      return fail("forbidden", message, { reason, ...(rule === undefined ? {} : { rule }) });
    };
    const lookup = this.#channelConversations;
    if (lookup === undefined) {
      return refuse("no_channel_policy", "no channel conversations are known to the broker");
    }
    const conv = await lookup({
      channel: input.channel,
      account: input.account,
      conversation: input.recipient,
    });
    if (conv === undefined) {
      return refuse("unknown_conversation", "nobody wrote in that conversation");
    }
    const now = this.clock.now();
    const age = now - conv.lastInboundAt;
    switch (input.purpose) {
      case "reply":
        if (conv.allows !== "reply") {
          return refuse("sender_not_allowed", "the channel's policy does not answer that sender");
        }
        if (age > CHANNEL_REPLY_WINDOW_MS) {
          return refuse("stale_conversation", "the last message there is too old to answer");
        }
        if (turn !== undefined) {
          // Only the conversation the request came from is not a new target (security §3.6);
          // the agent writing anywhere else goes through `decide` and asks.
          if (turn.requestRecipient !== input.recipient) {
            return turn.context.taint
              ? refuse("taint_new_target", "a tainted turn cannot send to a new conversation")
              : refuse("not_requesting_conversation", "replies go only to the requesting chat");
          }
          const { decision } = await this.engine.evaluate(
            {
              tool: "channel.reply",
              kind: "message_send",
              sideEffect: "destructive",
              targetKind: "recipient",
              target: { kind: "recipient", value: input.recipient },
              params: { channel: input.channel, recipient: input.recipient },
              paramsHash: input.bodySha256,
              binding: {
                channel: input.channel,
                account: input.account,
                recipient: input.recipient,
                bodySha256: input.bodySha256,
              },
            },
            { ...turn.context, newTarget: false },
          );
          // Hard prohibitions, deny rules, plan mode and requester limits refuse; the
          // destructive default `ask` is what this authority answers.
          if (decision.decision === "deny") {
            return refuse("policy_denied", decision.reason ?? "denied by policy", decision.rule);
          }
          if (decision.rule.startsWith("taint:")) {
            return refuse("taint_new_target", decision.reason ?? "tainted", decision.rule);
          }
        }
        break;
      case "pairing_code":
        if (turn !== undefined)
          return refuse("unexpected_turn", "pairing codes are not agent text");
        if (conv.allows !== "pairing_code" || age > CHANNEL_PAIRING_WINDOW_MS) {
          return refuse("not_pairing", "no fresh pairing request in that conversation");
        }
        break;
      case "approval_card":
        if (turn !== undefined)
          return refuse("unexpected_turn", "approval cards are not agent text");
        if (!conv.owner || conv.isGroup) {
          return refuse("not_owner_conversation", "approval cards go only to the owner's own chat");
        }
        break;
      default:
        return refuse("unknown_purpose", "unknown channel send purpose");
    }
    const key = `${input.channel}|${input.account}|${input.recipient}`;
    const times = (this.#replyTimes.get(key) ?? []).filter((t) => t > now - 60_000);
    if (times.length >= CHANNEL_REPLIES_PER_MINUTE) {
      await this.#log("approval.channel_reply_refused", { type: "system" }, subject, {
        reason: "rate_limited",
        purpose: input.purpose,
      });
      return fail("rate_limited", "too many sends to that conversation");
    }
    times.push(now);
    this.#replyTimes.set(key, times);
    const binding = bindingFor("message_send", {
      channel: input.channel,
      account: input.account,
      recipient: input.recipient,
      bodySha256: input.bodySha256,
    });
    if (input.bindingHash !== undefined && input.bindingHash !== binding.bindingHash) {
      return refuse("binding_mismatch", "the binding does not match the send");
    }
    const issued = this.#issue({
      kind: "message_send",
      summary: `Reply on ${input.channel}`,
      details: { channel: input.channel, account: input.account, purpose: input.purpose },
      bindingHash: binding.bindingHash,
      grantKey: binding.grantKey,
      requestedBy: {
        runId: turn?.context.runId ?? null,
        taskId: turn?.context.taskId ?? null,
        threadId: turn?.context.threadId ?? null,
        agent: `channel:${input.channel}`,
      },
      sideEffect: "write",
      surfaces: ["desktop"],
      scopesOffered: ["once"],
      taint: turn?.context.taint === true,
      ttlMs: CHANNEL_REPLY_TTL_MS,
    });
    const id = issued.approval.id;
    const at = new Date(now).toISOString();
    const decided = this.#store.transaction(() => {
      const rec = this.#store.getApproval(id) as StoredApproval;
      rec.approval.status = "approved";
      rec.approval.scopeGranted = "once";
      rec.approval.decidedBy = { channel: input.channel, senderId: conv.senderId };
      rec.approval.decidedAt = at;
      // Nobody answers a system-decided approval: its tokens are spent at birth.
      for (const t of rec.tokens) t.usedAt = at;
      this.#store.updateApproval(rec);
      return rec.approval;
    });
    this.#timers.get(id)?.();
    this.#timers.delete(id);
    await this.#log(
      "approval.channel_reply",
      { type: "channel" },
      { approvalId: id },
      {
        ...subject,
        purpose: input.purpose,
        senderId: conv.senderId,
        bindingHash: binding.bindingHash,
        ...(turn === undefined
          ? {}
          : { taint: turn.context.taint, mode: turn.context.permissionMode }),
        expiresAt: decided.expiresAt,
      },
    );
    return structuredClone(decided);
  }

  async revokeRunAuthority(runId: string): Promise<void> {
    for (const rec of this.#store.listApprovals()) {
      if (rec.approval.requestedBy.runId !== runId) continue;
      rec.revoked = true;
      this.#store.updateApproval(rec);
      if (rec.approval.status === "pending") await this.#invalidate(rec, "run_cancelled");
    }
  }

  // ---- receipts -----------------------------------------------------------------------------

  async recordReceipt(input: ReceiptInput): Promise<Receipt> {
    if (input.approvalId != null && this.#store.getApproval(input.approvalId) === undefined) {
      return fail("not_found", `approval ${input.approvalId} not found`);
    }
    const r = await this.receipts.record(input);
    this.#emit({ type: "receipt.created", receipt: r });
    return r;
  }

  async listReceipts(
    filter: { taskId?: string; toolCallId?: string; approvalId?: string; kind?: string } = {},
  ): Promise<Receipt[]> {
    return this.receipts.list(filter);
  }

  // ---- grant ledger -------------------------------------------------------------------------

  async listGrants(
    filter: GrantFilter & { scope?: GrantScope; taskId?: string; expiringWithinMs?: number } = {},
  ): Promise<Grant[]> {
    const now = this.clock.now();
    return this.#store
      .listGrants()
      .map((r) => r.grant)
      .filter((g) => filter.includeRevoked === true || g.revokedAt == null)
      .filter((g) => filter.kind === undefined || g.kind === filter.kind)
      .filter((g) => filter.scope === undefined || g.scope === filter.scope)
      .filter((g) => filter.taskId === undefined || g.taskId === filter.taskId)
      .filter((g) => {
        if (filter.expiringWithinMs === undefined) return true;
        if (g.expiresAt == null) return false;
        const left = Date.parse(g.expiresAt) - now;
        return left > 0 && left <= filter.expiringWithinMs;
      });
  }

  async revokeGrant(grantId: string, reason = "owner"): Promise<Grant> {
    const rec = this.#store.getGrant(grantId);
    if (rec === undefined) return fail("not_found", `grant ${grantId} not found`);
    if (rec.grant.revokedAt != null) return rec.grant;
    return (await this.#revoke(rec, reason)).grant;
  }

  async #revoke(rec: StoredGrant, reason: string): Promise<StoredGrant> {
    const next = structuredClone(rec);
    next.grant.revokedAt = new Date(this.clock.now()).toISOString();
    next.meta.revokedReason = reason;
    this.#store.updateGrant(next);
    // Outside the backup scope, so restoring an older backup cannot bring the grant back.
    this.#revocations?.recordGrant(next.grant.id, reason);
    this.#emit({ type: "grant.revoked", grant: next.grant });
    await this.#log(
      "grant.revoked",
      { type: "system" },
      { grantId: next.grant.id },
      { reason, kind: next.grant.kind, scope: next.grant.scope },
    );
    return next;
  }

  async #revokeWhere(pred: (g: StoredGrant) => boolean, reason: string): Promise<Grant[]> {
    const out: Grant[] = [];
    for (const g of this.#store.listGrants()) {
      if (g.grant.revokedAt == null && pred(g)) out.push((await this.#revoke(g, reason)).grant);
    }
    return out;
  }

  /** Settings → Permissions → "Revoke all" (feature F4). */
  revokeAllGrants(): Promise<Grant[]> {
    return this.#revokeWhere(() => true, "owner_revoked_all");
  }

  /** A revoked device takes the grants it approved with it (design-28). */
  revokeGrantsByDevice(deviceId: string): Promise<Grant[]> {
    return this.#revokeWhere((g) => g.meta.createdByDeviceId === deviceId, "device_revoked");
  }

  /** The server's `tools/list` hash changed: grants bound to another hash end (security §11). */
  revokeMcpGrants(serverId: string, currentToolsListHash: string): Promise<Grant[]> {
    return this.#revokeWhere(
      (g) =>
        (g.grant.kind === "mcp_tool" || g.grant.kind === "connector_action") &&
        g.grant.subject.serverId === serverId &&
        g.grant.subject.toolsListHash !== currentToolsListHash,
      "tools_list_changed",
    );
  }

  /** The Task reached a terminal state: its `task` grants end (security §3.4). */
  endTask(taskId: string): Promise<Grant[]> {
    this.#tasks.delete(taskId);
    return this.#revokeWhere(
      (g) => g.grant.scope === "task" && g.grant.taskId === taskId,
      "task_ended",
    );
  }

  /** `/new` in a thread: its `session` grants end. */
  endSession(threadId: string): Promise<Grant[]> {
    this.#tasks.delete(`thread:${threadId}`);
    this.#sessionFolders.delete(threadId);
    return this.#revokeWhere(
      (g) => g.grant.scope === "session" && g.meta.threadId === threadId,
      "session_ended",
    );
  }

  async exportGrants(): Promise<{ exportedAt: string; grants: Grant[] }> {
    return {
      exportedAt: new Date(this.clock.now()).toISOString(),
      grants: await this.listGrants({ includeRevoked: true }),
    };
  }

  taskStatus(taskId: string): { paused: boolean; downgraded: boolean } {
    const s = this.#tasks.get(taskId);
    return { paused: s?.paused ?? false, downgraded: s?.downgraded ?? false };
  }

  /** The owner resumes a Task the circuit breaker paused; it never resets itself. */
  resumeTask(taskId: string): void {
    const s = this.#tasks.get(taskId);
    if (s === undefined) return;
    s.paused = false;
    s.prohibited = 0;
  }
}

export function createPermissionBroker(options: PermissionBrokerOptions): PsychePermissionBroker {
  return new PsychePermissionBroker(options);
}
