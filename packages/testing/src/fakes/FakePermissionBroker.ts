import {
  APPROVAL_ARM_DELAY_MS,
  APPROVAL_TTL_MS,
  type ApprovalAnswerInput,
  type ApprovalKind,
  type ApprovalRequest,
  type ApprovalRequestInput,
  type ApprovalStatus,
  type BindingVerification,
  type Clock,
  type Decision,
  type DecisionContext,
  type DecisionResult,
  type Grant,
  type GrantFilter,
  type GrantScope,
  type IssuedApproval,
  type PermissionBroker,
  PsycheError,
  type Receipt,
  type ReceiptInput,
  type Requester,
  type SideEffect,
  type Surface,
  type ToolCallIntent,
} from "@psyche/protocol";
import { bindingHash as computeBindingHash } from "../canonical.ts";
import { captureModelVisible } from "../capture.ts";
import { FakeClock, toIso } from "../clock.ts";
import { createIdGenerator, type IdGenerator } from "../ids.ts";
import { fail } from "./errors.ts";

export interface FakePolicy {
  /** Fallback for anything not matched below (default: the mode table, simplified). */
  default?: Decision;
  byTool?: Record<string, Decision>;
  bySideEffect?: Partial<Record<SideEffect, Decision>>;
  /** Tools that hit a hard prohibition (always deny). */
  prohibited?: string[];
  /**
   * Per-person matrices for designated persons (security §9; S05 PR #89), keyed by identity id.
   * The owner's `default` / `byTool` / `bySideEffect` never apply to a non-owner requester: a
   * designated person gets their own matrix, then the mode table; an `allowed` sender gets
   * nothing above `read`. Standing grants never cross requesters.
   */
  designated?: Record<string, { byTool?: Record<string, Decision> }>;
}

/** Grant-ledger key of a requester: `null` for the owner (mirrors `@psyche/permissions`). */
export function requesterKey(requester: Requester | undefined): string | null {
  if (requester === undefined || requester.role === "owner") return null;
  if (requester.role === "designated") return `identity:${requester.identityId ?? "?"}`;
  return `sender:${requester.channel ?? "?"}:${requester.senderId ?? "?"}`;
}

/** Surfaces that reach the requester themselves: never approval surfaces (security §9). */
export function requesterSurfaces(requester: Requester | undefined): string[] {
  if (requester === undefined || requester.role === "owner") return [];
  const own = [...(requester.links ?? [])];
  if (requester.channel !== undefined && requester.senderId !== undefined) {
    own.push(`${requester.channel}:${requester.senderId}`);
  }
  if (requester.channel !== undefined && requester.chatId !== undefined) {
    own.push(`${requester.channel}:${requester.chatId}`);
  }
  return own;
}

export interface FakePermissionBrokerOptions {
  policy?: FakePolicy;
  clock?: Clock;
  ids?: IdGenerator;
  ttlMs?: number;
  armDelayMs?: number;
}

const HOUR = 3_600_000;
const GRANT_TTL_MS: Record<Exclude<GrantScope, "once">, number> = {
  task: 24 * HOUR,
  site: 30 * 24 * HOUR,
  session: 12 * HOUR,
  always: 90 * 24 * HOUR,
};
const ALL_SCOPES: GrantScope[] = ["once", "task", "site", "session", "always"];
const DEVICE_ONLY_KINDS: ApprovalKind[] = [
  "credential_fill",
  "exec_host",
  "purchase",
  "pairing",
  "policy_change",
];
const SEVERITY: Record<SideEffect, number> = {
  none: 0,
  read: 1,
  write: 2,
  destructive: 3,
  financial: 4,
};
const AUTH_KINDS: ApprovalKind[] = ["credential_fill", "purchase"];
const WRITE_PLUS: SideEffect[] = ["write", "destructive", "financial"];
const PERSONA_DENIED_KINDS: ApprovalKind[] = [
  "exec",
  "exec_host",
  "credential_fill",
  "purchase",
  "browser_submit",
  "memory_protected_write",
  "skill_install",
  "pairing",
  "policy_change",
];
const PERSONA_DENIED_TOOLS =
  /^(exec|exec_host|sandbox\.|credentials\.|vault\.|memory$|skills\.install)/;
const ONCE_ONLY_KINDS: ApprovalKind[] = [
  "pairing",
  "policy_change",
  "plan_exit",
  "skill_install",
  "apple_script",
  "shortcut_run",
];

/** Scopes a side-effect class / kind may ever be granted (security §3.4). */
export function allowedScopes(
  sideEffect: SideEffect | undefined,
  kind: ApprovalKind,
): GrantScope[] {
  if (sideEffect === "financial" || kind === "purchase") return ["once"];
  // Mirrors @psyche/permissions `allowedScopes`: these are approved per exact source, name +
  // input, hash or change (security §5.4, §11).
  if (ONCE_ONLY_KINDS.includes(kind)) return ["once"];
  if (kind === "credential_fill") return ["once", "site"];
  // Security §5.4: exec_host offers `once` or an `always` bound to exact argv + cwd + binary.
  if (kind === "exec_host") return ["once", "always"];
  if (sideEffect === "destructive") return ["once", "task"];
  return ALL_SCOPES;
}

export function inferApprovalKind(tool: string): ApprovalKind {
  if (tool === "apps.applescript") return "apple_script";
  if (tool === "apps.shortcut_run") return "shortcut_run";
  if (tool === "skills.install") return "skill_install";
  if (tool === "exec_host") return "exec_host";
  if (tool === "exec" || tool.startsWith("sandbox.")) return "exec";
  if (tool.startsWith("email.")) return "send_email";
  if (tool.startsWith("calendar.")) return "calendar_write";
  if (tool.startsWith("messages.") || tool.startsWith("channel.")) return "message_send";
  if (tool === "browser.submit") return "browser_submit";
  if (tool.startsWith("browser.")) return "new_origin";
  if (tool.startsWith("credentials.")) return "credential_fill";
  if (tool.startsWith("purchase") || tool.startsWith("link.")) return "purchase";
  if (tool === "write_file" || tool === "edit_file") return "file_write";
  if (tool.startsWith("mcp__")) return "mcp_tool";
  if (tool.startsWith("computer.")) return "computer_action";
  if (tool === "memory") return "memory_protected_write";
  if (tool === "task.start" || tool === "task.create") return "task_start";
  return "connector_action";
}

interface ApprovalEntry {
  approval: ApprovalRequest;
  input: ApprovalRequestInput;
  tokens: Map<string, { surface: Surface; used: boolean }>;
  consumed: boolean;
  revoked: boolean;
  cancelTimer?: () => void;
}

interface GrantEntry {
  grant: Grant;
  /** Side-effect class the grant was approved for; it never covers a more severe call. */
  sideEffect: SideEffect;
  /** `requesterKey` of the person whose request created it; grants never cross requesters. */
  requesterId: string | null;
}

/**
 * In-memory Permission Broker with the full approval lifecycle: policy evaluation in the
 * security §3.3 order (simplified), expiry on an injectable clock, single-use answer tokens per
 * surface, the 400 ms arm delay, first-answer-wins, binding re-verification with `once`
 * consumption, run revocation and restart re-issue. Not a policy engine: S05 owns that.
 */
/** `*` matches any run of characters; everything else is literal (a tool-name glob). */
function globMatches(glob: string, name: string): boolean {
  const re = glob
    .split("*")
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}$`).test(name);
}

export class FakePermissionBroker implements PermissionBroker {
  readonly clock: Clock;
  #ids: IdGenerator;
  #policy: FakePolicy;
  #ttlMs: number;
  #armDelayMs: number;
  #approvals = new Map<string, ApprovalEntry>();
  #grants = new Map<string, GrantEntry>();
  #receipts: Receipt[] = [];
  #waiters = new Map<string, Set<(a: ApprovalRequest) => void>>();
  /** Every decision, for assertions. */
  readonly decisions: { call: ToolCallIntent; ctx: DecisionContext; result: DecisionResult }[] = [];

  constructor(options: FakePermissionBrokerOptions = {}) {
    this.clock = options.clock ?? new FakeClock();
    this.#ids = options.ids ?? createIdGenerator();
    this.#policy = options.policy ?? {};
    this.#ttlMs = options.ttlMs ?? APPROVAL_TTL_MS;
    this.#armDelayMs = options.armDelayMs ?? APPROVAL_ARM_DELAY_MS;
  }

  static policy(policy: FakePolicy, options: Omit<FakePermissionBrokerOptions, "policy"> = {}) {
    return new FakePermissionBroker({ ...options, policy });
  }

  /** Replace the policy. */
  policy(policy: FakePolicy): this {
    this.#policy = policy;
    return this;
  }

  async decide(call: ToolCallIntent, ctx: DecisionContext): Promise<DecisionResult> {
    this.#sweep();
    const result = this.#evaluate(call, ctx);
    this.decisions.push({ call: structuredClone(call), ctx: { ...ctx }, result: { ...result } });
    return result;
  }

  #evaluate(call: ToolCallIntent, ctx: DecisionContext): DecisionResult {
    const se = call.sideEffect;
    const kind = call.kind ?? inferApprovalKind(call.tool);
    const grantKey = call.grantKey ?? `${call.tool}|${call.target?.value ?? "*"}`;
    const bindingHash =
      call.bindingHash ??
      computeBindingHash(kind, { tool: call.tool, paramsHash: call.paramsHash });
    const askInfo = {
      approvalKind: kind,
      // security §3.2: manual mode asks destructive actions with `once` only.
      scopesOffered:
        ctx.permissionMode === "manual" && se === "destructive"
          ? ["once" as const]
          : allowedScopes(se, kind),
      bindingHash,
      grantKey,
    };
    const ask = (rule: string, reason?: string): DecisionResult => ({
      decision: "ask",
      rule,
      ...(reason === undefined ? {} : { reason }),
      ...askInfo,
    });
    const deny = (rule: string, reason: string): DecisionResult => ({
      decision: "deny",
      rule,
      reason,
    });

    const p = this.#policy;
    if (p.prohibited?.includes(call.tool) === true)
      return deny("hard_prohibition", "hard prohibition");
    if (p.byTool?.[call.tool] === "deny") return deny(`policy:deny:${call.tool}`, "user deny rule");
    if (p.bySideEffect?.[se] === "deny") return deny(`policy:deny:${se}`, "user deny rule");
    if (ctx.permissionMode === "plan" && se !== "none") {
      return deny("mode:plan", "plan mode is read-only");
    }
    // Non-owner requesters (security §9): an allowed sender never changes anything; a
    // designated person is limited to their own matrix and the mode table.
    const requester = ctx.requester;
    const requesterId = requesterKey(requester);
    const designated = requester !== undefined && requester.role === "designated";
    if (requester !== undefined && requester.role === "allowed" && WRITE_PLUS.includes(se)) {
      return deny(
        "requester:not_owner",
        "only the owner or a designated person can request changes",
      );
    }
    // Nor are the owner's sources read for them (#293): only the public, cookie-less web.
    if (
      requester !== undefined &&
      requester.role === "allowed" &&
      se === "read" &&
      call.tool !== "web_search" &&
      call.tool !== "web_fetch"
    ) {
      return deny(
        "requester:not_owner",
        "an allowlisted sender cannot have the owner's messages, mail, files or memory read",
      );
    }
    // A chat-only route (`toolAllow: []`) gets no tools at all.
    if (
      requester !== undefined &&
      requester.role === "allowed" &&
      requester.toolAllow !== undefined &&
      !requester.toolAllow.some((g) => globMatches(g, call.tool))
    ) {
      return deny("requester:not_owner", `${call.tool} is not available in this sender's chat`);
    }
    if (designated && se === "financial") {
      return deny("designated:persona_limit", "a delegated persona cannot move money");
    }
    // Fixed persona limits (security §9, @psyche/permissions `checkRequester`): no exec, vault,
    // fills, money, protected memory or skill installs, and no browser or computer-use writes.
    if (
      designated &&
      (PERSONA_DENIED_KINDS.includes(kind) ||
        PERSONA_DENIED_TOOLS.test(call.tool) ||
        (WRITE_PLUS.includes(se) && (kind === "computer_action" || /^browser\./.test(call.tool))))
    ) {
      return deny("designated:persona_limit", `a delegated persona cannot use ${call.tool}`);
    }
    const personal = designated
      ? p.designated?.[requester.identityId ?? ""]?.byTool?.[call.tool]
      : undefined;
    if (personal === "deny") {
      return deny(`designated:deny:${call.tool}`, "the owner denies this for this person");
    }
    // Security §3.6: in a tainted turn, write+ on a new target and navigation to a new origin ask.
    const taintEscalates =
      ctx.taint &&
      ctx.newTarget === true &&
      (WRITE_PLUS.includes(se) || (kind === "new_origin" && se !== "none"));
    const taintRule = WRITE_PLUS.includes(se) ? "taint:new_target" : "taint:new_origin";

    const consultGrants = !(ctx.permissionMode === "manual" && WRITE_PLUS.includes(se));
    if (consultGrants && se !== "financial") {
      const grant = this.#matchGrant(grantKey, ctx.taskId, se, kind, requesterId);
      if (grant !== undefined) {
        if (taintEscalates) return ask(taintRule, "tainted turn, new target");
        grant.grant.useCount += 1;
        grant.grant.lastUsedAt = toIso(this.clock.now());
        return { decision: "allow", rule: `grant:${grant.grant.id}`, grantId: grant.grant.id };
      }
    }

    let value: Decision | undefined;
    let rule = "";
    if (designated) {
      // The owner's configured allowances are the owner's authority, never the person's.
      if (se === "destructive") return ask("designated:owner_approves", "the owner approves this");
      if (personal !== undefined) {
        value = personal;
        rule = `designated:${personal}:${call.tool}`;
      }
    } else {
      value = p.byTool?.[call.tool] ?? p.bySideEffect?.[se];
      rule =
        value === undefined ? "" : `policy:${p.byTool?.[call.tool] !== undefined ? call.tool : se}`;
      if (value === undefined && p.default !== undefined) {
        value = p.default;
        rule = "policy:default";
      }
    }
    if (value === undefined) {
      value = modeDefault(se, ctx);
      rule = `mode:${ctx.permissionMode}/${se}`;
    }
    if (value === "allow" && (se === "destructive" || se === "financial")) {
      return ask(`floor:${se}`, `${se} actions always ask`);
    }
    // The real engine names the taint rule whenever it decides the ask (security §3.3 step 4).
    if (value !== "deny" && taintEscalates) return ask(taintRule, "tainted turn, new target");
    if (value === "ask") return ask(rule);
    if (value === "deny") return deny(rule, "policy");
    return { decision: "allow", rule };
  }

  #matchGrant(
    grantKey: string,
    taskId: string | undefined,
    se: SideEffect,
    kind: ApprovalKind,
    requesterId: string | null,
  ): GrantEntry | undefined {
    const now = this.clock.now();
    const allowed = allowedScopes(se, kind);
    for (const entry of this.#grants.values()) {
      const g = entry.grant;
      if (g.revokedAt != null || g.grantKey !== grantKey) continue;
      // Grants never cross requesters (security §9).
      if (entry.requesterId !== requesterId) continue;
      if (g.expiresAt != null && Date.parse(g.expiresAt) <= now) continue;
      if (!allowed.includes(g.scope)) continue;
      if (SEVERITY[se] > SEVERITY[entry.sideEffect]) continue;
      if (g.scope === "task" && (g.taskId == null || g.taskId !== taskId)) continue;
      return entry;
    }
    return undefined;
  }

  async requestApproval(input: ApprovalRequestInput): Promise<IssuedApproval> {
    this.#sweep();
    captureModelVisible("approval_card", input, { where: "FakePermissionBroker.requestApproval" });
    return this.#issue(input);
  }

  #issue(input: ApprovalRequestInput): IssuedApproval {
    const now = this.clock.now();
    const se = input.sideEffect;
    const deviceOnly =
      DEVICE_ONLY_KINDS.includes(input.kind) || se === "destructive" || se === "financial";
    const requiresAuthentication = AUTH_KINDS.includes(input.kind) || se === "financial";
    // A non-owner requester never sees the card for their own request (security §9).
    const requester = input.context?.requester;
    const own = new Set(requesterSurfaces(requester));
    let surfaces = (
      deviceOnly ? input.surfaces.filter((s) => !s.includes(":")) : [...input.surfaces]
    ).filter((s) => !own.has(s));
    if (surfaces.length === 0) surfaces = ["desktop"];
    surfaces = [...new Set(surfaces)];
    const allowed = allowedScopes(se, input.kind);
    const hasTask = input.requestedBy.taskId != null;
    let scopesOffered = (input.scopesOffered ?? allowed).filter(
      (s) => allowed.includes(s) && (s !== "task" || hasTask),
    );
    if (scopesOffered.length === 0) scopesOffered = ["once"];
    const id = this.#ids.next("apr");
    const approval: ApprovalRequest = {
      id,
      kind: input.kind,
      summary: input.summary,
      details: structuredClone(input.details),
      bindingHash: input.bindingHash,
      grantKey: input.grantKey,
      requestedBy: { ...input.requestedBy },
      surfaces,
      scopesOffered,
      deviceOnly,
      requiresAuthentication,
      taint: input.taint,
      status: "pending",
      scopeGranted: null,
      decidedBy: null,
      requestedAt: toIso(now),
      expiresAt: toIso(now + (input.ttlMs ?? this.#ttlMs)),
      decidedAt: null,
      grantId: null,
    };
    if (se !== undefined) approval.sideEffect = se;
    if (input.targetKind !== undefined) approval.targetKind = input.targetKind;
    if (input.target !== undefined) approval.target = { ...input.target };
    if (requester !== undefined && requester.role !== "owner") {
      approval.details.requestedFor = `${requester.role}: ${
        requester.display ?? requester.identityId ?? requester.senderId ?? "unknown"
      }`;
    }
    const sources = input.taintSources ?? input.context?.taintSources;
    if (sources !== undefined && sources.length > 0) {
      approval.details.taintSources = sources.map((s) =>
        [s.sourceKind, s.origin ?? s.sender].filter((x) => x !== undefined).join(":"),
      );
      if (approval.taint) approval.taintSources = structuredClone(sources);
    }
    const tokens = new Map<string, { surface: Surface; used: boolean }>();
    const answerTokens: Record<Surface, string> = {};
    for (const surface of surfaces) {
      const token = `${this.#ids.next("tok")}.${surface}`;
      tokens.set(token, { surface, used: false });
      answerTokens[surface] = token;
    }
    const entry: ApprovalEntry = {
      approval,
      input: structuredClone(input),
      tokens,
      consumed: false,
      revoked: false,
    };
    this.#approvals.set(id, entry);
    entry.cancelTimer = this.#schedule(Date.parse(approval.expiresAt), () => this.#sweep());
    return { approval: structuredClone(approval), answerTokens };
  }

  #schedule(at: number, fn: () => void): () => void {
    const c = this.clock as Partial<FakeClock>;
    if (typeof c.setTimer === "function") return c.setTimer.call(this.clock, at, fn);
    const t = setTimeout(fn, Math.max(0, at - this.clock.now()));
    t.unref?.();
    return () => clearTimeout(t);
  }

  async answer(input: ApprovalAnswerInput): Promise<ApprovalRequest> {
    this.#sweep();
    const entry = this.#approvals.get(input.approvalId);
    if (entry === undefined) return fail("not_found", `approval ${input.approvalId} not found`);
    const a = entry.approval;
    if (a.status === "expired") return fail("approval_expired", "approval expired", { late: true });
    if (a.status === "invalidated") {
      return fail(
        "approval_invalidated",
        `approval invalidated (${a.invalidatedReason ?? "unknown"})`,
      );
    }
    const token = entry.tokens.get(input.answerToken);
    if (token === undefined) return fail("forbidden", "unknown answer token");
    if (token.used) return fail("answer_replayed", "answer token already used");
    if (a.status !== "pending") return fail("answer_late", `approval already ${a.status}`);
    if (this.clock.now() < Date.parse(a.requestedAt) + this.#armDelayMs) {
      return fail("approval_not_armed", "approval card is not armed yet");
    }
    const scope: GrantScope = input.scope ?? "once";
    if (input.decision === "approve" && !a.scopesOffered.includes(scope)) {
      return fail("invalid_params", `scope ${scope} not offered`);
    }
    token.used = true;
    const now = this.clock.now();
    a.decidedBy = structuredClone(input.decidedBy);
    a.decidedAt = toIso(now);
    if (input.decision === "deny") {
      a.status = "denied";
    } else {
      a.status = "approved";
      a.scopeGranted = scope;
      if (scope !== "once") {
        const grant: Grant = {
          id: this.#ids.next("grt"),
          kind: a.kind,
          scope,
          grantKey: a.grantKey,
          subject: {
            grantKey: a.grantKey,
            ...(a.target === undefined ? {} : { target: a.target }),
          },
          binding: null,
          expiresAt: toIso(now + GRANT_TTL_MS[scope]),
          useCount: 0,
          lastUsedAt: null,
          createdFromApprovalId: a.id,
          taskId: scope === "task" ? (a.requestedBy.taskId ?? null) : null,
          createdAt: toIso(now),
          revokedAt: null,
        };
        const sideEffect = entry.input.sideEffect;
        grant.subject.sideEffect = sideEffect;
        this.#grants.set(grant.id, {
          grant,
          sideEffect,
          requesterId: requesterKey(entry.input.context?.requester),
        });
        a.grantId = grant.id;
      }
    }
    entry.cancelTimer?.();
    this.#notify(a);
    return structuredClone(a);
  }

  awaitDecision(approvalId: string, signal?: AbortSignal): Promise<ApprovalRequest> {
    this.#sweep();
    const entry = this.#approvals.get(approvalId);
    if (entry === undefined)
      return Promise.reject(new PsycheError("not_found", "approval not found"));
    if (entry.approval.status !== "pending")
      return Promise.resolve(structuredClone(entry.approval));
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
    const entry = this.#approvals.get(approvalId);
    if (entry === undefined) return { ok: false, reason: "not_found" };
    const a = entry.approval;
    if (entry.revoked || a.status === "invalidated") return { ok: false, reason: "revoked" };
    if (a.status === "expired") return { ok: false, reason: "expired" };
    if (a.status !== "approved") return { ok: false, reason: "not_approved" };
    if (a.grantId != null) {
      const g = this.#grants.get(a.grantId)?.grant;
      if (g === undefined || g.revokedAt != null) return { ok: false, reason: "revoked" };
      if (g.expiresAt != null && this.clock.now() >= Date.parse(g.expiresAt)) {
        return { ok: false, reason: "expired" };
      }
    }
    if (bindingHash !== a.bindingHash) return { ok: false, reason: "binding_mismatch" };
    if (a.scopeGranted === "once") {
      if (entry.consumed) return { ok: false, reason: "consumed" };
      if (this.clock.now() >= Date.parse(a.expiresAt)) return { ok: false, reason: "expired" };
      entry.consumed = true;
    }
    return { ok: true, approval: structuredClone(a) };
  }

  async get(approvalId: string): Promise<ApprovalRequest | undefined> {
    this.#sweep();
    const a = this.#approvals.get(approvalId)?.approval;
    return a === undefined ? undefined : structuredClone(a);
  }

  async list(filter: { status?: ApprovalStatus } = {}): Promise<ApprovalRequest[]> {
    this.#sweep();
    return [...this.#approvals.values()]
      .map((e) => e.approval)
      .filter((a) => filter.status === undefined || a.status === filter.status)
      .map((a) => structuredClone(a));
  }

  async reissue(): Promise<IssuedApproval[]> {
    this.#sweep();
    const pending = [...this.#approvals.values()].filter((e) => e.approval.status === "pending");
    const issued: IssuedApproval[] = [];
    for (const entry of pending) {
      this.#invalidate(entry, "gateway_restart");
      issued.push(this.#issue(entry.input));
    }
    // Session grants end at a Gateway restart (security §3.4).
    const now = toIso(this.clock.now());
    for (const { grant } of this.#grants.values()) {
      if (grant.scope === "session" && grant.revokedAt == null) grant.revokedAt = now;
    }
    return issued;
  }

  /** Simulate a Gateway restart (alias of `reissue`). */
  restart(): Promise<IssuedApproval[]> {
    return this.reissue();
  }

  async recordReceipt(input: ReceiptInput): Promise<Receipt> {
    if (input.approvalId != null && !this.#approvals.has(input.approvalId)) {
      return fail("not_found", `approval ${input.approvalId} not found`);
    }
    const id = this.#ids.next("rcp");
    const receipt: Receipt = {
      id,
      shortId: input.shortId ?? `R${this.#receipts.length + 1}`,
      kind: input.kind,
      taskId: input.taskId ?? null,
      toolCallId: input.toolCallId ?? null,
      approvalId: input.approvalId ?? null,
      outcome: input.outcome,
      summary: input.summary,
      externalRefs: { ...(input.externalRefs ?? {}) },
      payload: input.payload == null ? null : structuredClone(input.payload),
      createdAt: toIso(this.clock.now()),
    };
    this.#receipts.push(receipt);
    captureModelVisible("receipt", receipt, { where: "FakePermissionBroker.recordReceipt" });
    return structuredClone(receipt);
  }

  async listReceipts(filter: { taskId?: string; toolCallId?: string } = {}): Promise<Receipt[]> {
    return this.#receipts
      .filter((r) => filter.taskId === undefined || r.taskId === filter.taskId)
      .filter((r) => filter.toolCallId === undefined || r.toolCallId === filter.toolCallId)
      .map((r) => structuredClone(r));
  }

  async revokeRunAuthority(runId: string): Promise<void> {
    for (const entry of this.#approvals.values()) {
      if (entry.approval.requestedBy.runId !== runId) continue;
      if (entry.approval.status === "pending") this.#invalidate(entry, "run_cancelled");
      entry.revoked = true;
    }
  }

  async listGrants(filter: GrantFilter = {}): Promise<Grant[]> {
    return [...this.#grants.values()]
      .map((e) => e.grant)
      .filter((g) => filter.includeRevoked === true || g.revokedAt == null)
      .filter((g) => filter.kind === undefined || g.kind === filter.kind)
      .map((g) => structuredClone(g));
  }

  async revokeGrant(grantId: string): Promise<Grant> {
    const entry = this.#grants.get(grantId);
    if (entry === undefined) return fail("not_found", `grant ${grantId} not found`);
    entry.grant.revokedAt ??= toIso(this.clock.now());
    return structuredClone(entry.grant);
  }

  #invalidate(entry: ApprovalEntry, reason: string): void {
    entry.approval.status = "invalidated";
    entry.approval.invalidatedReason = reason;
    entry.cancelTimer?.();
    this.#notify(entry.approval);
  }

  #sweep(): void {
    const now = this.clock.now();
    for (const entry of this.#approvals.values()) {
      const a = entry.approval;
      if (a.status === "pending" && now >= Date.parse(a.expiresAt)) {
        a.status = "expired";
        this.#notify(a);
      }
    }
  }

  #notify(a: ApprovalRequest): void {
    const set = this.#waiters.get(a.id);
    if (set === undefined) return;
    this.#waiters.delete(a.id);
    for (const w of set) w(structuredClone(a));
  }
}

function modeDefault(se: SideEffect, ctx: DecisionContext): Decision {
  if (se === "none") return "allow";
  if (se === "read") return ctx.permissionMode === "manual" ? "ask" : "allow";
  return "ask";
}
