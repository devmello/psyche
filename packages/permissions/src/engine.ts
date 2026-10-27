import type { ApprovalKind, GrantScope, JsonObject, SideEffect } from "@psyche/protocol";
import { appleAppAction, appleAppConnector, appleAppEffect } from "./apple-apps.ts";
import { appCap, effectiveTier, TIER_RANK, tierRequired } from "./apps.ts";
import { type Binding, bindingFor, genericBindingFor, readsCwdConfig } from "./binding.ts";
import {
  type ActionClassifier,
  buildClassifierInput,
  CLASSIFIER_TIMEOUT_MS,
  classifyFailClosed,
} from "./classifier.ts";
import { matrixFloor, matrixRule } from "./connector-matrix.ts";
import { missingFor } from "./missing.ts";
import {
  ALL_SCOPES,
  allowedScopes,
  BROWSER_WRITE_TOOLS,
  CODE_TOOLS,
  effectiveSideEffect,
  FILE_TOOLS,
  inferApprovalKind,
  mcpConnector,
  SEVERITY,
} from "./kinds.ts";
import { type CompiledPolicy, isSensitiveHost, ruleMatches } from "./policy.ts";
import { checkProhibitions, type LocalProjectVerifier } from "./prohibitions.ts";
import { checkRequester } from "./requester.ts";
import type { StoredGrant } from "./store.ts";
import { canonicalPath, canonicalUrl, isUnder } from "./targets.ts";
import type { PolicyCall, PolicyContext, PolicyDecision } from "./types.ts";

/**
 * Policy evaluation in the security §3.3 order; the first terminal result wins:
 * 1 hard prohibitions → 2 user deny rules (plus plan mode, matrices, folder and app tiers) →
 * 3 hooks (deny / ask only; a rewrite restarts at 1 and ends at ask) → 4 taint escalation →
 * 5 standing grants and configured allowances → 6 mode default → 7 classifier (auto, writes).
 * Every result carries the deciding rule and a trace of the steps that ran.
 */

export type HookResult =
  | { decision: "ask" | "deny"; reason?: string }
  /** Hooks never allow: an `allow` is ignored. */
  | { decision: "allow" }
  | { rewrite: PolicyCall; reason?: string };

export interface PolicyHook {
  readonly name: string;
  beforeToolCall(
    call: PolicyCall,
    ctx: PolicyContext,
  ): HookResult | undefined | Promise<HookResult | undefined>;
}

/** Per-Task (or per-thread) state the broker keeps in memory. */
export interface TaskState {
  /** Sources read in this Task (security §3.2 "new source"). */
  touched: Set<string>;
  /** Targets the owner approved in this Task (security §3.6 "new target"). */
  approvedTargets: Set<string>;
  prohibited: number;
  consecutiveSensitive: number;
  paused: boolean;
  downgraded: boolean;
}

/** A dry run's Task state: a copy of the broker's (or a fresh one), shared by the dry run's intents. */
function dryTask(dry: DryRun, d: EngineDeps, ctx: PolicyContext): TaskState {
  const key = taskKey(ctx);
  let s = dry.scratch.get(key);
  if (s === undefined) {
    s = structuredClone(d.peekTask(ctx)) ?? newTaskState();
    dry.scratch.set(key, s);
  }
  return s;
}

export function newTaskState(): TaskState {
  return {
    touched: new Set(),
    approvedTargets: new Set(),
    prohibited: 0,
    consecutiveSensitive: 0,
    paused: false,
    downgraded: false,
  };
}

/** The key a Task's state lives under: its task id, else its thread (plan and chat turns). */
export function taskKey(ctx: Pick<PolicyContext, "taskId" | "threadId">): string {
  return ctx.taskId ?? `thread:${ctx.threadId}`;
}

/**
 * A dry run (`PermissionBroker.preview`). Task state is copied into `scratch` on first use, so the
 * evaluation can mark sources touched and approved targets without changing the broker's own state.
 * Grants are not consumed and the classifier is not called (see `#once`).
 */
export interface DryRun {
  scratch: Map<string, TaskState>;
}

export interface EngineDeps {
  policy(): CompiledPolicy;
  /** Folders the owner allowed for one conversation only (`folder_access`, scope `once`). */
  sessionFolders?(threadId: string): readonly { path: string; mode: "ro" | "rw" }[];
  /** The Task's state, created on first use (`decide`). */
  task(ctx: PolicyContext): TaskState;
  /** The Task's state if the broker has one, without creating it (`preview`). */
  peekTask(ctx: PolicyContext): TaskState | undefined;
  matchGrant(
    grantKey: string,
    kind: ApprovalKind,
    se: SideEffect,
    ctx: PolicyContext,
    origin: string | undefined,
  ): StoredGrant | undefined;
  useGrant(rec: StoredGrant, bindingHash: string): StoredGrant;
  hooks: readonly PolicyHook[];
  classifier: ActionClassifier;
  localProject: LocalProjectVerifier;
  psycheHome: string | undefined;
  gatewayOrigins: readonly string[];
  /** Classifier labels and circuit-breaker trips. */
  onClassified(
    ctx: PolicyContext,
    call: PolicyCall,
    label: string,
    reason: string,
    breaker?: "pause" | "downgrade",
  ): Promise<void>;
}

class BindingMismatch extends Error {}

/** Kinds whose checks need kind-specific arguments; a caller cannot relabel a call out of them. */
const STRICT_KINDS: readonly ApprovalKind[] = [
  "exec",
  "exec_host",
  "send_email",
  "browser_submit",
  "credential_fill",
  "purchase",
  "file_write",
  "mcp_tool",
  "computer_action",
  "memory_protected_write",
];

/**
 * Kinds an `mcp__<server>__<tool>` registration may describe itself as. These tools are
 * registered by first-party code (the connectors registry, the MCP host), which names the §3.5
 * kind in `describeCall` (`send_email` for gmail_send, `connector_action` for third-party MCP
 * tools with the `tools/list` hash in their grant key). Kinds that need executor checks the
 * MCP path cannot give (`exec*`, fills, form submits, computer use, protected memory) stay
 * refused (issue #78).
 */
const MCP_DESCRIBABLE_KINDS: readonly ApprovalKind[] = [
  "mcp_tool",
  "connector_action",
  "send_email",
  "calendar_write",
  "message_send",
  "purchase",
];

/** Kinds whose checks read the binding fields: without arguments they never get standing grants. */
const FIELD_CHECKED_KINDS: readonly ApprovalKind[] = [
  "browser_submit",
  "credential_fill",
  "mcp_tool",
];

export interface Evaluation {
  decision: PolicyDecision;
  binding: Binding | undefined;
}

export function targetKey(call: PolicyCall): string | undefined {
  const t = call.target;
  if (t === undefined) return undefined;
  if (t.kind === "origin") return `origin:${safeOrigin(t.value) ?? t.value}`;
  return `${t.kind}:${t.kind === "recipient" ? t.value.toLowerCase() : t.value}`;
}

export function safeOrigin(value: string): string | undefined {
  try {
    return canonicalUrl(value).origin;
  } catch {
    return undefined;
  }
}

function originOf(call: PolicyCall): string | undefined {
  return call.target?.kind === "origin" ? safeOrigin(call.target.value) : undefined;
}

interface Floor {
  rule: string;
  reason: string;
  scopes?: GrantScope[];
}

interface Allowance {
  rule: string;
  grant?: StoredGrant;
}

export class PolicyEngine {
  readonly #d: EngineDeps;

  constructor(deps: EngineDeps) {
    this.#d = deps;
  }

  folderFor(
    path: string,
    threadId?: string,
  ): { path: string; mode: "ro" | "rw"; workspace: boolean } | undefined {
    const p = this.#d.policy();
    for (const root of p.workspaceRoots) {
      if (isUnder(path, root)) return { path: root, mode: "rw", workspace: true };
    }
    // The longest root decides, whether Settings or this conversation granted it.
    const roots = [
      ...p.folders,
      ...(threadId === undefined ? [] : (this.#d.sessionFolders?.(threadId) ?? [])),
    ].sort((a, b) => b.path.length - a.path.length);
    for (const f of roots) if (isUnder(path, f.path)) return { ...f, workspace: false };
    return undefined;
  }

  binding(call: PolicyCall, kind: ApprovalKind): Binding {
    const precomputed = call.bindingHash !== undefined && call.grantKey !== undefined;
    if (call.binding === undefined) {
      if (precomputed) {
        // The agent loop's MCP calls arrive precomputed; their meta names the server and the
        // tools/list hash, so the grant is found by revokeMcpGrants (#279).
        const m = call.meta;
        const mcp =
          typeof m?.mcpServerId === "string" && typeof m.mcpToolsListHash === "string"
            ? { serverId: m.mcpServerId, tool: call.tool, toolsListHash: m.mcpToolsListHash }
            : {};
        return {
          kind,
          fields: {},
          grantFields: mcp,
          bindingHash: call.bindingHash as Binding["bindingHash"],
          grantKey: call.grantKey as Binding["grantKey"],
        };
      }
      const target = call.target?.value;
      const b = genericBindingFor(kind, {
        tool: call.tool,
        paramsHash: call.paramsHash,
        ...(target === undefined ? {} : { target }),
      });
      return call.bindingHash === undefined
        ? b
        : { ...b, bindingHash: call.bindingHash as Binding["bindingHash"] };
    }
    let args = call.binding;
    if (kind === "file_write" && typeof args === "object" && args !== null && !("root" in args)) {
      const p = (args as { realPath?: unknown }).realPath;
      if (typeof p === "string") {
        const root = this.folderFor(canonicalPath(p))?.path;
        if (root !== undefined) args = { ...args, root };
      }
    }
    const b = bindingFor(kind, args);
    // A caller's precomputed hash must equal the one the arguments give (S05 review #11).
    if (call.bindingHash !== undefined && call.bindingHash !== b.bindingHash) {
      throw new BindingMismatch("the precomputed bindingHash does not match the arguments");
    }
    if (call.grantKey !== undefined && call.grantKey !== b.grantKey) {
      throw new BindingMismatch("the precomputed grantKey does not match the arguments");
    }
    return b;
  }

  /**
   * The one evaluation both `decide` and `preview` run (security §3.3). With `dry`, the evaluation
   * consumes no grant, calls no classifier and changes no Task state: it only reads.
   */
  async evaluate(original: PolicyCall, ctx: PolicyContext, dry?: DryRun): Promise<Evaluation> {
    const trace: string[] = [];
    let call = original;
    let rewritten = false;
    for (let round = 0; ; round += 1) {
      const r = await this.#once(call, ctx, trace, rewritten, dry);
      if (!("rewrite" in r)) return r;
      trace.push(`hook:rewrite(${r.hook})`);
      if (round >= 2) {
        return this.#out(
          call,
          ctx,
          trace,
          "deny",
          "hook:rewrite_loop",
          "hooks rewrote the call too often",
          {
            kind: call.kind ?? inferApprovalKind(call.tool),
            se: call.sideEffect,
          },
        );
      }
      call = r.rewrite;
      rewritten = true;
    }
  }

  #out(
    call: PolicyCall,
    ctx: PolicyContext,
    trace: string[],
    decision: "allow" | "ask" | "deny",
    rule: string,
    reason: string | undefined,
    x: {
      kind: ApprovalKind;
      se: SideEffect;
      binding?: Binding;
      scopes?: GrantScope[];
      grantId?: string;
      typedConfirmation?: string;
      classifier?: PolicyDecision["classifier"];
    },
  ): Evaluation {
    trace.push(`${decision}:${rule}`);
    const d: PolicyDecision = { decision, rule, trace: [...trace], sideEffect: x.se, call };
    if (reason !== undefined) d.reason = reason;
    if (x.grantId !== undefined) d.grantId = x.grantId;
    if (x.classifier !== undefined) d.classifier = x.classifier;
    if (x.binding !== undefined) {
      d.bindingHash = x.binding.bindingHash;
      d.grantKey = x.binding.grantKey;
    }
    if (decision === "deny") {
      const fields = {
        ...((call.params as Record<string, unknown> | undefined) ?? {}),
        ...((x.binding?.fields as Record<string, unknown> | undefined) ?? {}),
      };
      const missing = missingFor(rule, call, x.se, fields);
      if (missing !== undefined) d.missing = missing;
    }
    if (decision === "ask") {
      d.approvalKind = x.kind;
      d.scopesOffered = x.scopes ?? allowedScopes(x.se, x.kind);
      if (x.typedConfirmation !== undefined) d.typedConfirmation = x.typedConfirmation;
      if (ctx.unattended === true) d.deferred = true;
    }
    return { decision: d, binding: x.binding };
  }

  async #once(
    call: PolicyCall,
    ctx: PolicyContext,
    trace: string[],
    rewritten: boolean,
    dry: DryRun | undefined,
  ): Promise<Evaluation | { rewrite: PolicyCall; hook: string }> {
    const d = this.#d;
    const p = d.policy();
    const inferred = inferApprovalKind(call.tool);
    const kind = call.kind ?? inferred;
    const se = effectiveSideEffect(call.tool, call.sideEffect);
    if (se !== call.sideEffect) trace.push(`floor:${call.sideEffect}->${se}`);
    const tainted = ctx.taint || ctx.initiator === "mcp_app";
    const state = dry === undefined ? d.task(ctx) : dryTask(dry, d, ctx);
    const mode =
      state.downgraded && ctx.permissionMode === "auto" ? "balanced" : ctx.permissionMode;
    const origin = originOf(call);
    const base = { kind, se };
    const done = (
      decision: "allow" | "ask" | "deny",
      rule: string,
      reason?: string,
      x: object = {},
    ) => this.#out(call, ctx, trace, decision, rule, reason, { ...base, ...x });

    const relabel =
      call.kind !== undefined &&
      call.kind !== inferred &&
      STRICT_KINDS.includes(inferred) &&
      !(inferred === "mcp_tool" && MCP_DESCRIBABLE_KINDS.includes(call.kind));
    if (relabel) {
      return done("deny", "kind:mismatch", `${call.tool} is a ${inferred} call, not ${call.kind}`);
    }
    let binding: Binding;
    try {
      binding = this.binding(call, kind);
    } catch (e) {
      if (e instanceof BindingMismatch) return done("deny", "binding:mismatch", e.message);
      return done("deny", "binding:invalid", e instanceof Error ? e.message : "binding failed");
    }
    // Without kind-specific arguments the field checks cannot run (cross-origin form actions,
    // fill field class, the MCP tools/list hash), so such calls get `once` only (review #7, #11).
    const unbound = call.binding === undefined && FIELD_CHECKED_KINDS.includes(kind);
    if (state.paused)
      return done("deny", "classifier:task_paused", "paused after repeated prohibited actions");

    // 1. Hard prohibitions.
    trace.push("step1:prohibitions");
    const prohibited = await checkProhibitions(
      call,
      ctx,
      {
        ...(d.psycheHome === undefined ? {} : { psycheHome: d.psycheHome }),
        gatewayOrigins: d.gatewayOrigins,
        localProject: d.localProject,
        allowEnv: (p.config.exec?.allowEnv as string[] | undefined) ?? [],
      },
      kind,
    );
    if (prohibited?.effect === "deny") return done("deny", prohibited.id, prohibited.reason);
    const floors: Floor[] = [];
    let typedConfirmation: string | undefined;
    if (prohibited !== undefined) {
      if (prohibited.effect === "confirm") typedConfirmation = prohibited.word;
      floors.push({ rule: prohibited.id, reason: prohibited.reason, scopes: ["once"] });
    }

    // 2. User deny rules, plan mode, matrices, folders, app tiers.
    trace.push("step2:deny_rules");
    const denyRule = p.deny.find((r) => ruleMatches(r, call.tool, call.target));
    if (denyRule !== undefined)
      return done("deny", `policy:deny:${denyRule.raw}`, "user deny rule");
    if (mode === "plan" && se !== "none")
      return done("deny", "mode:plan", "plan mode runs only side-effect-free tools");
    if (kind === "exec_host" && p.config.exec?.execHostEnabled !== true) {
      return done("deny", "exec_host:disabled", "exec_host is off (exec.execHostEnabled)");
    }
    const allowances: Allowance[] = [];
    const askRule = p.ask.find((r) => ruleMatches(r, call.tool, call.target));
    if (askRule !== undefined)
      floors.push({ rule: `policy:ask:${askRule.raw}`, reason: "user ask rule" });
    const allowRule = p.allow.find((r) => ruleMatches(r, call.tool, call.target));
    if (allowRule !== undefined) allowances.push({ rule: `policy:allow:${allowRule.raw}` });

    // Non-owner requesters (security §9): persona limits, tool list and per-identity matrix.
    const requesterAllowances: Allowance[] = [];
    for (const v of checkRequester(call, ctx, kind, se, p.designated)) {
      if (v === undefined) continue;
      if (v.effect === "deny") return done("deny", v.rule, v.reason);
      if (v.effect === "ask") floors.push({ rule: v.rule, reason: v.reason });
      else requesterAllowances.push({ rule: v.rule });
    }

    const connector =
      call.connectorRule ??
      call.meta?.connector ??
      mcpConnector(call.tool) ??
      appleAppConnector(call.tool);
    if (connector !== undefined) {
      // The owner's matrix entry for the action group (Settings → Connectors, #747); an older
      // `policy.connectors` entry under the tool's own name still applies when the group has none.
      const matrix = p.config.connectors?.[connector.id];
      const legacy = appleAppAction(call.tool)?.action ?? mcpConnector(call.tool)?.action;
      const configured =
        matrixRule(matrix, connector.action) ??
        (legacy === undefined ? undefined : matrixRule(matrix, legacy));
      // Apple app adapters (J6) carry defaults, and `alwaysAsk` actions never become silent.
      const effect = appleAppEffect(call.tool, configured);
      const rule = `connector:${connector.id}/${connector.action}`;
      if (effect === "deny") return done("deny", rule, "connector matrix denies this action");
      if (effect === "ask") floors.push({ rule, reason: "connector matrix asks" });
      if (effect === "allow") {
        // Hard floors: an owner `allow` never silences sends, destructive or device-only calls.
        const floor = matrixFloor(kind, se);
        if (floor === undefined) allowances.push({ rule });
        else floors.push({ rule: `${rule}:floor`, reason: floor });
      }
    }

    if (origin !== undefined) {
      const host = canonicalUrl(origin).host;
      const site = p.sites.find((s) => s.pattern.test(host) || s.pattern.test(origin));
      if (site?.effect === "deny") return done("deny", `site:deny:${site.raw}`, "site is denied");
      if (site?.effect === "ask")
        floors.push({ rule: `site:ask:${site.raw}`, reason: "site asks" });
      if (site?.effect === "allow") allowances.push({ rule: `site:allow:${site.raw}` });
      if (BROWSER_WRITE_TOOLS.test(call.tool) || kind === "browser_submit") {
        const set = ctx.originSet;
        if (set?.readWritable?.some((o) => safeOrigin(o) === origin) === true) {
          allowances.push({ rule: "origin_set:rw" });
        } else if (set?.readOnly?.some((o) => safeOrigin(o) === origin) === true) {
          floors.push({ rule: "origin_set:read_only", reason: "writes on a read-only origin ask" });
        }
      }
    }
    if (kind === "browser_submit") {
      const f = binding.fields as { actionOrigin?: string; origin?: string };
      if (f.actionOrigin !== undefined && f.origin !== undefined && f.actionOrigin !== f.origin) {
        floors.push({
          rule: "submit:cross_origin_action",
          reason: `the form posts to ${f.actionOrigin}`,
          scopes: ["once"],
        });
      }
    }

    if ((FILE_TOOLS.has(call.tool) || CODE_TOOLS.test(call.tool)) && call.target?.kind === "path") {
      let path: string;
      try {
        path = canonicalPath(call.target.value);
      } catch {
        return done("deny", "folder:invalid_path", "file targets must be absolute paths");
      }
      const folder = this.folderFor(path, ctx.threadId);
      if (folder === undefined)
        return done("deny", "folder:not_granted", `${path} is outside every granted folder`);
      if (folder.mode === "ro" && SEVERITY[se] >= SEVERITY.write) {
        return done("deny", "folder:read_only", `${folder.path} is granted read-only`);
      }
      allowances.push({ rule: folder.workspace ? "folder:workspace" : `folder:${folder.mode}` });
    }
    if (kind === "exec_host") {
      // Security §5.4: a host command runs only in a folder the owner granted. It grants no
      // allowance: every call still asks unless an `always` grant covers it exactly.
      // The loop sends a precomputed binding, so the arguments carry the cwd there.
      const raw =
        (binding.fields as { cwd?: unknown }).cwd ?? (call.params as { cwd?: unknown })?.cwd;
      let cwd: string;
      try {
        cwd = canonicalPath(typeof raw === "string" ? raw : "");
      } catch {
        return done("deny", "folder:invalid_path", "exec_host needs an absolute cwd");
      }
      if (this.folderFor(cwd, ctx.threadId) === undefined) {
        return done("deny", "folder:not_granted", `${cwd} is outside every granted folder`, {
          binding,
        });
      }
    }
    if (kind === "memory_protected_write") {
      floors.push({ rule: "memory:protected_path", reason: "protected memory files always ask" });
    }
    if (kind === "git_push") {
      // A push publishes commits with the owner's credentials: never silent, never reusable (V10).
      floors.push({ rule: "git:push", reason: "pushes always ask", scopes: ["once"] });
    }

    const targetApp = call.target?.kind === "app" ? call.target.value : undefined;
    const app = call.meta?.app ?? targetApp;
    if (
      kind === "computer_action" &&
      call.meta?.app !== undefined &&
      targetApp !== undefined &&
      call.meta.app.toLowerCase() !== targetApp.toLowerCase()
    ) {
      // The tier check must judge the app the call acts on, never a lenient one beside it.
      return done("deny", "app_tier:mismatch", "the action's app does not match its target");
    }
    if (kind === "computer_action" && app !== undefined) {
      const { tier, capped, reason } = effectiveTier(
        app,
        Object.entries(p.config.apps ?? {}).find(
          ([k]) => k.toLowerCase() === app.toLowerCase(),
        )?.[1],
      );
      // The action the executor described (`computer.act` → `click` or `type`), else the tool.
      const needed = tierRequired(call.meta?.action ?? call.tool);
      if (tier === "off") return done("deny", "app_tier:off", reason || `${app} is off`);
      const cap = appCap(app);
      if (TIER_RANK[cap.cap] < TIER_RANK[needed])
        return done("deny", `app_tier:${cap.cap}`, cap.reason);
      if (tier !== undefined && TIER_RANK[tier] < TIER_RANK[needed]) {
        return done(
          "deny",
          `app_tier:${tier}`,
          capped ? reason : `${app} is ${tier}; ${needed} is needed`,
        );
      }
      if (tier !== undefined) allowances.push({ rule: `app_tier:${tier}` });
    }

    // Security §11: write+ tools of unknown-tier MCP servers ask every time, whatever grants
    // exist (#280). MCP calls arrive as `connector_action` from @psyche/mcp-host with the tier in
    // meta; an `mcp__` tool that names no tier counts as unknown.
    // First-party connector tools (`@psyche/connectors` registry) are `mcp__` named too, but carry
    // their action group as `connectorRule` and no MCP tier: the owner's matrix governs them.
    const firstParty = call.connectorRule !== undefined && call.meta?.mcpTier === undefined;
    const mcpTier =
      call.meta?.mcpTier ?? (call.tool.startsWith("mcp__") && !firstParty ? "unknown" : undefined);
    if (
      (kind === "mcp_tool" || kind === "connector_action") &&
      mcpTier === "unknown" &&
      SEVERITY[se] >= SEVERITY.write
    ) {
      floors.push({
        rule: "mcp:unknown_tier",
        reason: "tools of unknown MCP servers ask",
        scopes: ["once"],
      });
    }

    let noAlways = false;
    if (kind === "exec_host") {
      const b = (call.binding ?? {}) as { executable?: unknown; cwdConfigHashes?: unknown };
      // Without binding fields (the loop's precomputed binding) argv[0] names the program.
      const argv0 = (call.params as { argv?: unknown[] } | undefined)?.argv?.[0];
      const executable = typeof b.executable === "string" ? b.executable : argv0;
      noAlways =
        typeof executable === "string" &&
        readsCwdConfig(executable) &&
        b.cwdConfigHashes === undefined;
    }

    // 3. Hooks.
    trace.push("step3:hooks");
    for (const hook of d.hooks) {
      const h = await hook.beforeToolCall(structuredClone(call), structuredClone(ctx));
      if (h === undefined) continue;
      if ("rewrite" in h) return { rewrite: h.rewrite, hook: hook.name };
      if (h.decision === "deny")
        return done("deny", `hook:${hook.name}`, h.reason ?? "hook denied");
      if (h.decision === "ask")
        floors.push({ rule: `hook:${hook.name}`, reason: h.reason ?? "hook asks" });
    }
    if (rewritten) {
      floors.push({
        rule: "hook:rewrite",
        reason: "a hook rewrote the arguments",
        scopes: ["once"],
      });
    }

    // The owner's own inbox (#307): `notify` reaches only the owner, like the reply in their own
    // chat, so it is not an action the owner approves: no card in any mode, tainted or not (an
    // automation's deliverable is delivered, docs/02 §4.3). Plan mode, deny rules, prohibitions
    // and the requester check above still apply, and so do user ask rules and hooks (floors).
    if (
      call.tool === "notify" &&
      call.target?.kind === "recipient" &&
      call.target.value === "owner" &&
      se === "write" &&
      floors.length === 0
    ) {
      return done("allow", "owner_inbox", undefined, { binding });
    }

    // 4. Taint escalation.
    trace.push("step4:taint");
    const tk = targetKey(call);
    const newTarget = ctx.newTarget ?? (tk === undefined ? true : !state.approvedTargets.has(tk));
    let escalation: Floor | undefined;
    if (tainted) {
      if (SEVERITY[se] >= SEVERITY.write && newTarget) {
        escalation = {
          rule: "taint:new_target",
          reason: "untrusted content was read and the target is new",
        };
      } else if (
        kind === "new_origin" &&
        newTarget &&
        // A read of an origin the owner already approved with a live standing grant is not new
        // (security §3.2 balanced reads honor standing grants; §3.6 lets taint override
        // site / session / always grants only for write and above).
        !(
          SEVERITY[se] <= SEVERITY.read &&
          d.matchGrant(binding.grantKey, kind, se, ctx, origin) !== undefined
        )
      ) {
        escalation = {
          rule: "taint:new_origin",
          reason: "navigation to a new origin in a tainted turn",
        };
      }
      if (kind === "credential_fill") {
        const fillOrigin = (binding.fields as { origin?: string }).origin ?? origin;
        const sources = (ctx.taintSources ?? []).flatMap((s) =>
          s.origin === undefined ? [] : [safeOrigin(s.origin) ?? s.origin],
        );
        if (fillOrigin === undefined || !sources.includes(fillOrigin)) {
          escalation = {
            rule: "taint:fill_origin",
            reason: "the fill origin differs from every tainting origin",
          };
        }
      }
      if (
        (kind === "exec" || kind === "exec_host") &&
        (call.meta?.network === "proxy" ||
          (binding.fields as { network?: string }).network === "proxy" ||
          call.meta?.writesOutsideWorkspace === true)
      ) {
        escalation = {
          rule: "taint:exec_egress",
          reason: "exec with network or outside writes in a tainted turn",
        };
      }
      // Security §5.4 / §3.6: a host command in a tainted turn always asks and is offered
      // `once` only; no standing grant covers it and no exemption applies.
      if (kind === "exec_host") {
        escalation = {
          rule: escalation?.rule ?? "taint:exec_host",
          reason: escalation?.reason ?? "a command on this Mac in a tainted turn",
          scopes: ["once"],
        };
      }
      if (escalation !== undefined) trace.push(escalation.rule);
    }

    const scopesFor = (offer: GrantScope[]) => {
      let s = allowedScopes(se, kind).filter((x) => offer.includes(x));
      for (const f of floors)
        if (f.scopes !== undefined) s = s.filter((x) => f.scopes?.includes(x));
      if (noAlways) s = s.filter((x) => x !== "always");
      if (unbound) s = s.filter((x) => x === "once");
      if (ctx.taskId === undefined) s = s.filter((x) => x !== "task");
      if (kind !== "credential_fill" && origin === undefined) s = s.filter((x) => x !== "site");
      return s.length === 0 ? (["once"] as GrantScope[]) : s;
    };
    const ask = (rule: string, reason?: string, offer: GrantScope[] = ALL_SCOPES) =>
      done("ask", rule, reason, {
        binding,
        // Manual: writes and above are `once` only; first reads offer task / site (security §3.2).
        scopes: scopesFor(
          mode !== "manual"
            ? offer
            : SEVERITY[se] >= SEVERITY.write
              ? ["once"]
              : ["once", "task", "site"],
        ),
        ...(typedConfirmation === undefined ? {} : { typedConfirmation }),
      });

    const floor = floors[0];
    if (floor !== undefined) return ask(floor.rule, floor.reason);

    // Sensitive categories always ask for reads, whatever grants exist (security §3.2).
    const sensitiveRead =
      se === "read" && origin !== undefined && isSensitiveHost(p, canonicalUrl(origin).host);
    if (sensitiveRead) {
      if (escalation !== undefined) return ask(escalation.rule, escalation.reason, ["once"]);
      return ask(`mode:${mode}/read:sensitive`, "sensitive-category source", ["once"]);
    }

    // The owner's configured allowances are the owner's authority: a designated person gets only
    // their own matrix's `allow` rules (and their own grants, matched by requester).
    if (ctx.requester !== undefined && ctx.requester.role !== "owner") {
      allowances.splice(0, allowances.length, ...requesterAllowances);
    }

    // 5. Standing grants and configured allowances.
    trace.push("step5:grants");
    const consult = !(mode === "manual" && SEVERITY[se] >= SEVERITY.write) && se !== "financial";
    let allowed: Allowance | undefined;
    if (consult) {
      const g = d.matchGrant(binding.grantKey, kind, se, ctx, origin);
      if (g !== undefined && !unbound) allowed = { rule: `grant:${g.grant.id}`, grant: g };
      else if (SEVERITY[se] <= SEVERITY.write) allowed = allowances[0];
    }
    if (allowed !== undefined) {
      if (escalation !== undefined)
      return ask(escalation.rule, escalation.reason, escalation.scopes);
      // 7. Classifier: residual writes in auto mode.
      let classifier: PolicyDecision["classifier"];
      if (mode === "auto" && se === "write") {
        // A dry run cannot call the classifier (a model call, with audit and breaker effects), so
        // it reports the residual write as asking; the label decides only when the call runs.
        if (dry !== undefined) {
          return ask("classifier:deferred", "the action classifier decides when the call runs");
        }
        trace.push("step7:classifier");
        const c = await this.#classify(call, ctx, state, allowed, origin);
        classifier = { label: c.label, reason: c.reason };
        if (c.label === "sensitive") return ask("classifier:sensitive", c.reason);
        if (c.label === "prohibited")
          return done("deny", "classifier:prohibited", c.reason, { classifier });
      }
      if (tk !== undefined && SEVERITY[se] <= SEVERITY.read) state.touched.add(tk);
      if (allowed.grant !== undefined) {
        // A dry run names the grant it would use without counting a use of it.
        const grantId =
          dry === undefined
            ? d.useGrant(allowed.grant, binding.bindingHash).grant.id
            : allowed.grant.grant.id;
        return done("allow", allowed.rule, undefined, {
          binding,
          grantId,
          classifier,
        });
      }
      return done("allow", allowed.rule, undefined, { binding, classifier });
    }

    // 6. Mode default (security §3.2).
    trace.push("step6:mode_default");
    if (escalation !== undefined)
      return ask(escalation.rule, escalation.reason, escalation.scopes);
    const modeRule = `mode:${mode}/${se}`;
    switch (se) {
      case "none":
        return done("allow", modeRule, undefined, { binding });
      case "read": {
        const host = origin === undefined ? undefined : canonicalUrl(origin).host;
        if (host !== undefined && isSensitiveHost(p, host)) {
          return ask(`${modeRule}:sensitive`, "sensitive-category source");
        }
        if (tk === undefined) return done("allow", modeRule, undefined, { binding });
        if (mode === "auto" && !tainted) {
          state.touched.add(tk);
          return done("allow", modeRule, undefined, { binding });
        }
        if (state.touched.has(tk))
          return done("allow", `${modeRule}:touched`, undefined, { binding });
        return ask(`${modeRule}:new_source`, "first read of a new source in this task");
      }
      case "write":
        return ask(modeRule);
      case "destructive":
        return ask(modeRule);
      case "financial":
        return ask(modeRule, undefined, ["once"]);
    }
  }

  async #classify(
    call: PolicyCall,
    ctx: PolicyContext,
    state: TaskState,
    allowed: Allowance,
    origin: string | undefined,
  ) {
    const d = this.#d;
    const p = d.policy();
    const host = origin === undefined ? undefined : canonicalUrl(origin).host;
    const input = buildClassifierInput(call, ctx, {
      ...(allowed.grant === undefined ? {} : { grant: allowed.grant.grant }),
      sensitiveTarget: host !== undefined && isSensitiveHost(p, host),
    });
    const out = await classifyFailClosed(
      d.classifier,
      input,
      p.config.classifier?.timeoutMs ?? CLASSIFIER_TIMEOUT_MS,
    );
    let breaker: "pause" | "downgrade" | undefined;
    if (out.label === "routine") state.consecutiveSensitive = 0;
    else if (out.label === "sensitive") {
      state.consecutiveSensitive += 1;
      if (state.consecutiveSensitive >= 3 && !state.downgraded) {
        state.downgraded = true;
        breaker = "downgrade";
      }
    } else {
      state.prohibited += 1;
      state.consecutiveSensitive = 0;
      if (state.prohibited >= 2 && !state.paused) {
        state.paused = true;
        breaker = "pause";
      }
    }
    await d.onClassified(ctx, call, out.label, out.reason, breaker);
    return out;
  }
}

export type { JsonObject };
