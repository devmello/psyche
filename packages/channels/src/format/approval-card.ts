import {
  denyHintText,
  kindTitle,
  renderForSurface,
  sanitizeDisplay,
  TOO_LONG_TEXT,
} from "@psyche/permissions/cards";
import type { ApprovalKind, ApprovalRequest } from "@psyche/protocol";
import { localizeCardText, localizeKindTitle } from "../text.ts";

/**
 * Chat approval cards (architecture §4.6, security §3.7 and §9, review design-12). The text is
 * `renderForSurface` from `@psyche/permissions`, the one renderer every surface (desktop kit,
 * notifications, chat) uses, so what a chat may show cannot drift from what the Broker decided:
 * a fixed plain-text template with the security-relevant lines first, every attacker-reachable
 * string in a sanitized value slot, no parse mode, a pointer to the Mac instead of a truncated
 * card, and for `deviceOnly` approvals the header and "Answer this on your Mac." only. This
 * module adds the chat-specific trailer (relative expiry, `/approve` ref and fallback).
 */

/**
 * What an answer confirmation names ("Send email — bob@x.com"): the kind's title and, when the
 * request has one, its exact target, sanitized and cut short. Localized by the caller's language.
 */
export function approvalWhat(approval: Pick<ApprovalRequest, "kind" | "target">): string {
  const title = localizeKindTitle(kindTitle(approval.kind));
  const raw = approval.target?.display ?? approval.target?.value;
  if (raw === undefined || raw.trim() === "") return title;
  return `${title} — ${sanitizeDisplay(raw, 80)}`;
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

export interface ApprovalCard {
  text: string;
  /** False when the chat may not answer: the card did not fit, or the approval is device-only. */
  answerable: boolean;
  reason?: "device_only" | "too_long";
}

export interface ApprovalCardOptions {
  /** The Broker surface this card is for (`<channel>:<peerId>`); picks the template and limit. */
  surface: string;
  /** Short reference used by `/approve <ref> approve|deny`. */
  ref: string;
  now: number;
  /** The transport's own message limit, when tighter than the surface's. */
  maxChars?: number;
  /** Add the `/approve` fallback lines (channels without buttons). */
  commandFallback?: boolean;
}

export function renderApprovalCard(
  approval: ApprovalRequest,
  options: ApprovalCardOptions,
): ApprovalCard {
  const rendered = renderForSurface(options.surface, approval);
  const header = rendered.text.split("\n")[0] ?? "";
  if (rendered.deviceOnly) {
    return {
      // A device-only approval is refused from chat whatever the answer (no `/deny` either).
      text: localizeCardText(rendered.text),
      answerable: false,
      reason: "device_only",
    };
  }
  const tooLong = (): ApprovalCard => ({
    text: localizeCardText(`${header}\n${TOO_LONG_TEXT}\n${denyHintText(options.ref)}`),
    answerable: false,
    reason: "too_long",
  });
  if (rendered.truncated) return tooLong();
  const minutes = Math.max(0, Math.round((Date.parse(approval.expiresAt) - options.now) / 60_000));
  const lines = [rendered.text, `Expires in ${minutes} min · ref ${options.ref}`];
  if (options.commandFallback === true) {
    lines.push(`Reply "/approve ${options.ref} approve" or "/approve ${options.ref} deny".`);
  }
  const text = localizeCardText(lines.join("\n"));
  if (options.maxChars !== undefined && text.length > options.maxChars) return tooLong();
  return { text, answerable: true };
}

/**
 * The message a chat gets for an approval it may not answer (device-only kinds, financial, or
 * `destructive` without opt-in): the header and "Answer this on your Mac.", never the arguments.
 */
export function renderDevicePointer(
  surface: string,
  approval: ApprovalRequest,
  options: { deny?: boolean } = {},
): string {
  const text = renderForSurface(surface, { ...approval, deviceOnly: true }).text;
  // Deny is always safe, so a pointer names `/deny <ref>`; there is never an `/approve` here.
  // A weak transport (a spoofable sender) gets no command at all (`deny: false`).
  return localizeCardText(
    options.deny === false || approval.deviceOnly
      ? text
      : `${text}\n${denyHintText(approvalRef(approval.id))}`,
  );
}

/** Short, stable reference for `/approve <ref>`: the last 8 characters of the id, lowercased. */
export function approvalRef(approvalId: string): string {
  return approvalId.slice(-8).toLowerCase();
}
