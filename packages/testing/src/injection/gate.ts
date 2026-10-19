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
  /^(permissions|grants|approvals|policy|pairing|config|settings|devices|vault)\.|^channels\.(pairing|policy)/;

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

export function approvalKindFor(call: AttackToolCall): ApprovalKind {
  if (call.approvalKind !== undefined) return call.approvalKind as ApprovalKind;
  const t = call.tool;
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
