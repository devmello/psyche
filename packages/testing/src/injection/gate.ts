import {
  type ApprovalKind,
  type ApprovalRequest,
  type AuditLog,
  type CredentialBroker,
  type DecisionResult,
  type MemoryStore,
  type PermissionBroker,
  type PermissionMode,
  parsePlaceholders,
  type Requester,
  type ToolCallIntent,
} from "@psyche/protocol";
import { canonicalJSON, sha256 } from "../canonical.ts";
import { bindingMatches } from "../fakes/FakeCredentialBroker.ts";
import type { AttackToolCall } from "./types.ts";

/**
 * What decides a hijacked tool call: the system under test for the injection runner. The
 * reference gate below composes the fakes with the deterministic rules docs/05 assigns to the
 * agent loop's `before_tool_call` and the executors (no settings tool, placeholder rejection,
 * fill origin binding, the memory write gate). When S02's agent loop and S05/S06/S07's packages
 * merge, a gate backed by them replaces it and the report records which parts were real.
 */
export interface ToolGate {
  readonly name: string;
  /** Per component: `real` package or `fake`. Recorded in the report. */
  readonly implementations: Record<string, "real" | "fake" | "reference">;
  evaluate(call: AttackToolCall, turn: GateTurn): Promise<GateResult>;
}

export interface GateTurn {
  caseId: string;
  mode: PermissionMode;
  threadId: string;
  runId: string;
  taskId: string;
  taint: boolean;
  /** `<sourceKind>:<origin or sender>` per tainting read. */
  taintSources: string[];
  unattended: boolean;
  /** The target is new relative to the owner's request and earlier approvals (security §3.6). */
  newTarget: boolean;
  /** A non-owner who started the turn on a channel (security §9); absent for the owner. */
  requester?: Requester;
}

export interface GateResult {
  decision: "executed" | "asked" | "blocked";
  rule: string;
  approval?: ApprovalRequest;
  /** Answer tokens of the issued approval, for follow-up steps (never model-visible). */
  answerTokens?: Record<string, string>;
}

/** Tool families with no tool path at all (security §3.9, §10, §15.4 item 3). */
export const CONTROL_PLANE_TOOL =
  /^(permissions|grants|approvals|policy|pairing|config|settings|devices|vault|models)\.|^channels\.(pairing|policy)|^skills\.(trust|set_trust|setTrust|enable|disable)$/;

/**
 * Paths no agent tool reads or writes, whatever folder is granted (security §5.3, #285):
 * Psyche's own home and the owner's credential stores.
 */
export const PROTECTED_PATH =
  /(^|\/)(\.psyche|\.ssh|\.aws|\.gnupg|\.kube|Library\/Keychains)(\/|$)/;
const PATH_TOOLS =
  /^(read_file|write_file|edit_file|list_dir|search_files|code\.(open|read|search|edit|run|git))$/;
const CODE_TOOLS = /^code\.(open|read|search|edit|run|git)$/;
/**
 * The folder the owner granted in every injection stack, as cases write it: the reference gate
 * checks paths against it symbolically, the M2 stack maps it to its real temporary folder.
 */
export const GRANTED_FOLDER = "@GRANTED@";

function pathArgs(call: AttackToolCall): string[] {
  const a = (call.args ?? {}) as Record<string, unknown>;
  const root = typeof a.root === "string" ? a.root : "";
  const out: string[] = [];
  for (const k of ["path", "root", "cwd"]) {
    const v = a[k];
    if (typeof v !== "string") continue;
    out.push(v.startsWith("/") || root === "" ? v : `${root}/${v}`);
  }
  if (typeof a.patch === "string") {
    for (const m of a.patch.matchAll(/^\+\+\+ b\/(.+)$/gm)) out.push(`${root}/${m[1]}`);
  }
  return out;
}

/** Lexical normalization (`a/b/../c` → `a/c`) for the reference path checks. */
function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

/** Executors allowed to receive `{{cred:…}}` placeholders (security §4.5–§4.6). */
export const FILL_TOOLS = new Set(["credentials.request", "browser.fill", "browser.type"]);

/** Protected behavior files (security §8). */
export const PROTECTED_MEMORY_FILES = new Set([
  "MEMORY.md",
  "USER.md",
  "SOUL.md",
  "IDENTITY.md",
  "AGENTS.md",
]);

/**
 * Capabilities no agent tool reaches (gateway `isUnreachableCapability`): `dictation.*` types into
 * the focused app as the owner and only the desktop calls it (J9); vault and keychain capabilities
 * are the Credential Broker's. A `nodes.invoke` naming one of them is refused the same way.
 */
export const UNREACHABLE_CAPABILITY =
  /^(vault|keychain|settings|permissions|grants|approvals|devices|gateway|dictation)([^a-z0-9]|$)/;

/**
 * Fixed computer-use caps (security §12 "Tiers and fixed caps", F6): the reference stand-in for
 * the broker's app tiers and the helper's own check. Bundle ids compare without case.
 */
const LOCKED_OFF_APPS = [
  "com.1password.*",
  "com.agilebits.*",
  "com.bitwarden.*",
  "com.apple.passwords",
  "com.apple.keychainaccess",
  "com.apple.systempreferences",
  "com.apple.systemsettings",
  "com.chase.*",
  "com.paypal.*",
  "com.robinhood.*",
  "com.coinbase.*",
  "com.schwab.*",
  "com.fidelity.*",
];
const BROWSER_APPS = [
  "com.apple.safari",
  "com.google.chrome",
  "org.mozilla.firefox",
  "com.microsoft.edgemac",
  "company.thebrowser.browser",
  "com.brave.browser",
];
const TERMINAL_IDE_APPS = [
  "com.apple.terminal",
  "com.googlecode.iterm2",
  "dev.warp.warp-stable",
  "com.mitchellh.ghostty",
  "com.microsoft.vscode",
  "dev.zed.zed",
  "com.apple.dt.xcode",
  "com.jetbrains.*",
];
const TIER_RANK = { off: 0, read: 1, click: 2, interact: 3 } as const;
type AppTier = keyof typeof TIER_RANK;

function matchesApp(bundleId: string, patterns: readonly string[]): boolean {
  const id = bundleId.toLowerCase();
  return patterns.some((p) => (p.endsWith(".*") ? id.startsWith(p.slice(0, -1)) : id === p));
}

export function appCapFor(bundleId: string): AppTier {
  if (matchesApp(bundleId, LOCKED_OFF_APPS)) return "off";
  if (matchesApp(bundleId, BROWSER_APPS)) return "read";
  if (matchesApp(bundleId, TERMINAL_IDE_APPS)) return "click";
  return "interact";
}

/** Tier a computer-use call needs: `computer.act` names its action, other tools are the action. */
export function tierRequiredFor(call: AttackToolCall): AppTier {
  if (call.tool === "apps.applescript" || call.tool === "apps.shortcut_run") return "interact";
  const action = (call.args as { action?: unknown } | null)?.action;
  const a = (typeof action === "string" ? action : call.tool).replace(/^(computer|apps)\./, "");
  if (["snapshot", "screenshot", "ax_tree", "list", "list_windows", "find", "zoom"].includes(a))
    return "read";
  if (["click", "double_click", "scroll", "hover", "open", "open_app", "focus"].includes(a))
    return "click";
  return "interact";
}

/** Bundle ids for the app names scripts commonly address (`tell application "Terminal"`). */
const APP_NAMES: Record<string, string> = {
  terminal: "com.apple.terminal",
  iterm: "com.googlecode.iterm2",
  iterm2: "com.googlecode.iterm2",
  safari: "com.apple.safari",
  "google chrome": "com.google.chrome",
  "1password": "com.1password.1password",
  "1password 7": "com.agilebits.onepassword7",
  "system settings": "com.apple.systemsettings",
  "system preferences": "com.apple.systempreferences",
  "keychain access": "com.apple.keychainaccess",
  passwords: "com.apple.passwords",
};

/** Shell escapes and input injection a script may never use (security §5.4: no host shell). */
const SCRIPT_SHELL_ESCAPE =
  /do\s+shell\s+script|do\s+script|run\s+script|load\s+script|«event\s+syso(exec|dsct)»|doshellscript|\$\.|objc\.|system\s+events|keystroke|key\s+code/i;

/**
 * Every app a script addresses, however it spells the reference: `application "X"`,
 * `application id "X"`, `app "X"`, `app id "X"`, `Application('X')`.
 */
export function scriptAddressedApps(source: string): string[] {
  const out: string[] = [];
  const re = /\b(?:application|app)\s*(?:id\s*)?(?:\(\s*)?["']([^"']+)["']/gi;
  for (const m of source.matchAll(re)) {
    const raw = (m[1] ?? "").trim();
    out.push(raw.includes(".") ? raw : (APP_NAMES[raw.toLowerCase()] ?? raw));
  }
  return out;
}

/** Apple app adapter kinds (mirrors @psyche/permissions `APPLE_APP_ACTIONS`). */
function appleAdapterKind(capability: string): ApprovalKind | undefined {
  if (capability === "mail.send") return "send_email";
  if (/^calendar\.(create|update)_event$/.test(capability)) return "calendar_write";
  if (capability === "safari.open_url") return "new_origin";
  if (/^(calendar|reminders|mail|notes|finder|safari)\./.test(capability))
    return "connector_action";
  return undefined;
}

export function approvalKindFor(call: AttackToolCall): ApprovalKind {
  if (call.approvalKind !== undefined) return call.approvalKind as ApprovalKind;
  const t = call.tool;
  if (t === "code.run") return "exec";
  if (t === "code.edit") return "file_write";
  if (t === "code.git") {
    const op = (call.args as { op?: unknown } | null)?.op;
    return op === "push" ? "git_push" : "git_write";
  }
  if (/^(shop_checkout_handoff|travel\.(hold_fare|ticket_hold|book))$/.test(t)) return "purchase";
  if (t === "apps.applescript") return "apple_script";
  if (t === "apps.shortcut_run") return "shortcut_run";
  if (t.startsWith("apps.")) return "computer_action";
  if (t === "node.messages.send") return "message_send";
  const adapter = t.startsWith("node.") ? appleAdapterKind(t.slice(5)) : undefined;
  if (adapter !== undefined) return adapter;
  if (t === "exec_host") return "exec_host";
  if (t === "exec" || t.startsWith("sandbox.")) return "exec";
  if (/^(gmail|email|mail)\.(send|forward|reply)/.test(t)) return "send_email";
  if (t.startsWith("calendar.")) return "calendar_write";
  if (t.startsWith("messages.") || t.startsWith("channel")) return "message_send";
  if (t === "browser.submit") return "browser_submit";
  if (t === "browser.navigate" || t === "fetch") return "new_origin";
  if (t.startsWith("credentials.") || FILL_TOOLS.has(t)) return "credential_fill";
  if (t.startsWith("purchase")) return "purchase";
  if (t.startsWith("skills.")) return "skill_install";
  if (t.startsWith("memory.")) return "memory_protected_write";
  if (t.startsWith("files.") || t === "write_file" || t === "edit_file") return "file_write";
  if (t.startsWith("mcp__")) return "mcp_tool";
  if (t.startsWith("computer.")) return "computer_action";
  return "connector_action";
}

/** Coarse grant key: kind + canonical target (the reference stand-in for security §3.5). */
export function grantKeyFor(kind: string, target: string | undefined): string {
  return `${kind}|${(target ?? "*").toLowerCase()}`;
}

function memoryPath(args: unknown): string | undefined {
  const path = (args as { path?: unknown } | null)?.path;
  return typeof path === "string" ? path.split("/").pop() : undefined;
}

export interface ReferenceGateDeps {
  broker: PermissionBroker;
  credentials: CredentialBroker;
  memory: MemoryStore;
  audit: AuditLog;
  /** `exec_host` is Off by default (security §5.4). */
  execHostEnabled?: boolean;
}

export class ReferenceToolGate implements ToolGate {
  readonly name = "reference";
  readonly implementations = {
    gate: "reference",
    permissionBroker: "fake",
    credentialBroker: "fake",
    memoryStore: "fake",
    auditLog: "fake",
  } as const;
  #d: ReferenceGateDeps;

  constructor(deps: ReferenceGateDeps) {
    this.#d = deps;
  }

  async #block(call: AttackToolCall, turn: GateTurn, rule: string): Promise<GateResult> {
    await this.#d.audit.append({
      kind: "tool.blocked",
      actor: { type: "agent", runId: turn.runId },
      subject: { taskId: turn.taskId, caseId: turn.caseId },
      data: { tool: call.tool, rule, taint: turn.taint },
    });
    return { decision: "blocked", rule };
  }

  async evaluate(call: AttackToolCall, turn: GateTurn): Promise<GateResult> {
    // 1. Hard prohibitions with no tool path.
    if (CONTROL_PLANE_TOOL.test(call.tool)) {
      return this.#block(call, turn, "prohibition:no_settings_tool");
    }
    if (call.tool === "exec_host" && this.#d.execHostEnabled !== true) {
      return this.#block(call, turn, "exec_host:disabled");
    }
    const capability =
      call.tool === "nodes.invoke"
        ? (call.args as { capability?: unknown } | null)?.capability
        : call.tool.replace(/^node\./, "");
    if (typeof capability === "string" && UNREACHABLE_CAPABILITY.test(capability.toLowerCase())) {
      return this.#block(call, turn, "node:unreachable_capability");
    }
    // `nodes.invoke` is a paired client's RPC, never an agent tool.
    if (call.tool === "nodes.invoke") return this.#block(call, turn, "node:client_only");
    if (
      PATH_TOOLS.test(call.tool) &&
      pathArgs(call).some((p) => PROTECTED_PATH.test(normalizePath(p)))
    ) {
      return this.#block(call, turn, "prohibition:protected_path");
    }
    // The coding helper works only inside folders the owner granted (security §3.3 step 2, the
    // engine's `folder:not_granted`), whatever the payload says about `..` or another root.
    if (
      CODE_TOOLS.test(call.tool) &&
      pathArgs(call).some((p) => !`${normalizePath(p)}/`.startsWith(`/${GRANTED_FOLDER}/`))
    ) {
      return this.#block(call, turn, "folder:not_granted");
    }
    // Computer use: the fixed caps hold whatever the owner's tier or a grant says (§12).
    if (
      approvalKindFor(call) === "computer_action" ||
      /^apps\.(applescript|shortcut_run)$/.test(call.tool)
    ) {
      const app =
        call.tool === "apps.shortcut_run"
          ? "com.apple.shortcuts"
          : call.targetKind === "app"
            ? call.target
            : undefined;
      if (app !== undefined) {
        const cap = appCapFor(app);
        if (TIER_RANK[cap] < TIER_RANK[tierRequiredFor(call)]) {
          return this.#block(call, turn, `app_tier:${cap}`);
        }
        // Opening a document in a terminal or IDE runs it on the host: exec_host by another
        // name (security §5.4), whatever click tier or grant the app has.
        const url = (call.args as { url?: unknown } | null)?.url;
        if (call.tool === "apps.open" && typeof url === "string" && cap === "click") {
          return this.#block(call, turn, "exec_host:disabled");
        }
      }
      if (call.tool === "apps.applescript") {
        const source = String((call.args as { source?: unknown } | null)?.source ?? "");
        if (SCRIPT_SHELL_ESCAPE.test(source)) {
          return this.#block(call, turn, "apple_script:shell_escape");
        }
        for (const addressed of scriptAddressedApps(source)) {
          const cap = appCapFor(addressed);
          if (TIER_RANK[cap] < TIER_RANK.interact)
            return this.#block(call, turn, `app_tier:${cap}`);
        }
      }
    }
    // 2. Placeholders resolve only in fill executors, only for a matching binding.
    const argText = canonicalJSON(call.args ?? null);
    const placeholders = parsePlaceholders(argText);
    const mentionsCred = argText.includes("{{cred:");
    if (mentionsCred && !FILL_TOOLS.has(call.tool)) {
      return this.#block(call, turn, "placeholder:rejected");
    }
    if (FILL_TOOLS.has(call.tool) || call.tool.startsWith("credentials.")) {
      const items = await this.#d.credentials.list();
      const target = { kind: call.targetKind ?? "origin", value: call.target ?? "" } as const;
      const slugs = placeholders.map((p) => p.slug);
      const itemArg = (call.args as { item?: unknown } | null)?.item;
      if (typeof itemArg === "string") slugs.push(itemArg);
      if (mentionsCred && placeholders.length === 0) {
        return this.#block(call, turn, "placeholder:malformed");
      }
      for (const slug of slugs) {
        const meta = items.find((i) => i.slug === slug);
        if (meta === undefined) return this.#block(call, turn, "credential:not_found");
        if (!bindingMatches(meta.bindings, target)) {
          return this.#block(call, turn, "credential:origin_mismatch");
        }
      }
    }
    // 3. Memory write gate: untrusted-derived writes never reach protected files.
    const file = call.tool.startsWith("memory.") ? memoryPath(call.args) : undefined;
    if (file !== undefined && PROTECTED_MEMORY_FILES.has(file) && turn.taint) {
      return this.#block(call, turn, "memory:untrusted_not_promoted");
    }
    // 4. The Permission Broker.
    const kind = approvalKindFor(call);
    const grantKey = grantKeyFor(kind, call.target);
    const intent: ToolCallIntent = {
      tool: call.tool,
      sideEffect: call.sideEffect,
      params: call.args,
      paramsHash: sha256(argText),
      kind,
      grantKey,
    };
    if (call.targetKind !== undefined) intent.targetKind = call.targetKind;
    if (call.target !== undefined) {
      intent.target = { kind: call.targetKind ?? "origin", value: call.target };
    }
    const result: DecisionResult = await this.#d.broker.decide(intent, {
      threadId: turn.threadId,
      runId: turn.runId,
      taskId: turn.taskId,
      permissionMode: turn.mode,
      taint: turn.taint,
      newTarget: turn.newTarget,
      unattended: turn.unattended,
      ...(turn.requester === undefined ? {} : { requester: turn.requester }),
    });
    if (result.decision === "deny") return this.#block(call, turn, result.rule);
    if (result.decision === "allow") return { decision: "executed", rule: result.rule };
    const issued = await this.#d.broker.requestApproval({
      kind: result.approvalKind ?? kind,
      summary: `${call.tool} → ${call.target ?? "(no target)"}`,
      details: { tool: call.tool, target: call.target ?? null, args: JSON.parse(argText) },
      bindingHash: result.bindingHash ?? sha256(`${kind}|${argText}`),
      grantKey: result.grantKey ?? grantKey,
      requestedBy: { runId: turn.runId, taskId: turn.taskId, threadId: turn.threadId },
      sideEffect: call.sideEffect,
      ...(call.targetKind === undefined ? {} : { targetKind: call.targetKind }),
      ...(intent.target === undefined ? {} : { target: intent.target }),
      surfaces: ["desktop", "telegram:owner"],
      ...(result.scopesOffered === undefined ? {} : { scopesOffered: result.scopesOffered }),
      taint: turn.taint,
    });
    return {
      decision: "asked",
      rule: result.rule,
      approval: issued.approval,
      answerTokens: issued.answerTokens,
    };
  }
}
