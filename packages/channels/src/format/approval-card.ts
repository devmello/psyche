import type { ApprovalKind, ApprovalRequest } from "@psyche/protocol";
import { sanitizeValue } from "./sanitize.ts";

/**
 * Chat approval cards (architecture §4.6, security §3.7 and §9, review design-12). A card is a
 * fixed plain-text template: the security-relevant lines (action class, target) come first,
 * every attacker-reachable string is a sanitized value slot, nothing goes through a parse mode,
 * and a card that does not fit the surface is replaced by a pointer to a paired device instead
 * of being truncated.
 */

const KIND_LABELS: Record<ApprovalKind, string> = {
  exec: "Run a command",
  exec_host: "Run a command on the host",
  send_email: "Send an email",
  calendar_write: "Change your calendar",
  message_send: "Send a message",
  browser_submit: "Submit a web form",
  credential_fill: "Fill a saved credential",
  purchase: "Make a purchase",
  file_write: "Write a file",
  connector_action: "Connector action",
  computer_action: "Control an app",
  new_origin: "Open a new site",
  plan_exit: "Leave plan mode",
  skill_install: "Install a skill",
  mcp_tool: "Call an MCP tool",
  archive_thread: "Archive a thread",
  memory_protected_write: "Change a protected memory file",
  pairing: "Pair a device or sender",
  policy_change: "Change a permission policy",
};

export function kindLabel(kind: ApprovalKind): string {
  return KIND_LABELS[kind] ?? kind;
}

/** Kinds that never reach chat, whatever the request's `deviceOnly` says (security §3.7, §9). */
export const CHAT_FORBIDDEN_KINDS: ReadonlySet<ApprovalKind> = new Set<ApprovalKind>([
  "purchase",
  "credential_fill",
  "exec_host",
  "policy_change",
  "pairing",
]);

export type ChatEligibility = { ok: true } | { ok: false; reason: string };

/**
 * Whether an approval may be delivered to (and answered from) a chat surface. `deviceOnly`,
 * `financial` and the forbidden kinds never are. `destructive` is allowed only when the channel
 * opts in: architecture §4.6 says chat approves `write` only while security §9 also lists
 * `destructive` (review design-04); the stricter reading is the default.
 */
export function chatEligibility(
  approval: Pick<ApprovalRequest, "deviceOnly" | "kind" | "sideEffect">,
  options: { allowDestructive?: boolean } = {},
): ChatEligibility {
  if (approval.deviceOnly) return { ok: false, reason: "device_only" };
  if (CHAT_FORBIDDEN_KINDS.has(approval.kind))
    return { ok: false, reason: `kind:${approval.kind}` };
  const effect = approval.sideEffect ?? "write";
  if (effect === "financial") return { ok: false, reason: "financial" };
  if (effect === "destructive" && options.allowDestructive !== true)
    return { ok: false, reason: "destructive" };
  return { ok: true };
}

function detailValue(value: unknown): string {
  return sanitizeValue(typeof value === "string" ? value : JSON.stringify(value));
}

export interface ApprovalCard {
  text: string;
  /** False when the card did not fit and was replaced by a "review on your device" note. */
  answerable: boolean;
}

export interface ApprovalCardOptions {
  /** Short reference used by `/approve <ref> approve|deny`. */
  ref: string;
  now: number;
  maxChars?: number;
  /** Add the `/approve` fallback lines (channels without buttons). */
  commandFallback?: boolean;
}

export function renderApprovalCard(
  approval: ApprovalRequest,
  options: ApprovalCardOptions,
): ApprovalCard {
  const lines: string[] = [];
  const effect = approval.sideEffect ?? "write";
  lines.push(`Approval needed: ${kindLabel(approval.kind)} [${effect}]`);
  if (approval.target !== undefined) {
    lines.push(`Target (${approval.target.kind}): ${sanitizeValue(approval.target.value)}`);
  }
  lines.push(`Request: ${sanitizeValue(approval.summary)}`);
  for (const [key, value] of Object.entries(approval.details)) {
    if (value === undefined) continue;
    lines.push(`- ${sanitizeValue(key)}: ${detailValue(value)}`);
  }
  if (approval.taint) lines.push("Note: this run read untrusted content.");
  const minutes = Math.max(0, Math.round((Date.parse(approval.expiresAt) - options.now) / 60_000));
  lines.push(`Expires in ${minutes} min · ref ${options.ref}`);
  if (options.commandFallback === true) {
    lines.push(`Reply "/approve ${options.ref} approve" or "/approve ${options.ref} deny".`);
  }
  const text = lines.join("\n");
  if (options.maxChars !== undefined && text.length > options.maxChars) {
    return {
      text: `Approval needed: ${kindLabel(approval.kind)} [${effect}]. It is too long to show here; review it in Psyche on a paired device (ref ${options.ref}).`,
      answerable: false,
    };
  }
  return { text, answerable: true };
}

/** Short, stable reference for `/approve <ref>`: the last 8 characters of the id, lowercased. */
export function approvalRef(approvalId: string): string {
  return approvalId.slice(-8).toLowerCase();
}
