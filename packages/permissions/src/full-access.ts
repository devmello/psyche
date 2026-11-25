import type { ApprovalKind, SideEffect } from "@psyche/protocol";
import { SEND_KINDS } from "./connector-matrix.ts";
import { SEVERITY } from "./kinds.ts";
import type { PolicyCall } from "./types.ts";

/**
 * Full access (owner, 2026-11-25): what still goes through the usual Balanced decision, with its
 * card, in a Full-access chat. Everything else the hard prohibitions, deny rules and the owner's
 * own ask rules let through runs without a card.
 *
 * - `payment`: purchases and anything `financial` (presence stays as it is: Touch ID or password).
 * - `send`, `invite`, `post`: anything that reaches another person (email, iMessage and other
 *   messages, calendar invites, posts, replies, comments, shares): one tap per send.
 * - `credential`: filling a saved login from the vault.
 * - `security`: pairing, policy and permission changes, folder pickers, skill installs, Night
 *   shift applies, leaving plan mode.
 * - `script`: an AppleScript or Shortcut, whose source can send or pay in ways Psyche can't read.
 * - `publish`: a git push (commits published with the owner's credentials).
 * - `consent`: accepting terms or granting an OAuth consent on the owner's behalf.
 */
export type FullAccessHold =
  | "payment"
  | "send"
  | "invite"
  | "post"
  | "credential"
  | "security"
  | "script"
  | "publish"
  | "consent";

const SECURITY_KINDS: readonly ApprovalKind[] = [
  "pairing",
  "policy_change",
  "permission_request",
  "folder_access",
  "skill_install",
  "separate_desktop_share",
  "staged_apply",
  "plan_exit",
];

const SCRIPT_KINDS: readonly ApprovalKind[] = ["apple_script", "shortcut_run"];

/** Word segments of a tool name that make it a send to someone else, whatever its kind. */
const SEND_WORDS = new Set([
  "send",
  "post",
  "publish",
  "tweet",
  "retweet",
  "reply",
  "comment",
  "share",
  "invite",
  "forward",
  "dm",
  "broadcast",
  "announce",
]);

const CONSENT_WORDS = new Set(["consent", "oauth_consent", "accept_terms"]);

/**
 * The lower-cased word segments of a tool name, NFKC-folded (an MCP server picks its own names, so `ｓｅｎｄ` is `send`): `mcp__slack__chat.postMessage` gives
 * `mcp slack chat post message`. Splits on `_ . - /`, spaces and camelCase humps.
 */
export function sendWords(tool: string): string[] {
  return tool
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
}

function record(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

const PEOPLE_KEYS = ["attendees", "invitees", "guests", "participants", "optionalAttendees"];

/** A call that names other people to notify: attendees, invitees, or updates sent to them. */
function notifiesPeople(call: PolicyCall): boolean {
  const p = record(call.params) ?? {};
  for (const scope of [p, record(p.event) ?? {}, record(p.binding) ?? {}]) {
    for (const k of PEOPLE_KEYS) {
      const v = scope[k];
      if (Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.trim() !== "") return true;
    }
    const updates = scope.sendUpdates ?? scope.sendNotifications ?? scope.notifyAttendees;
    if (updates === true || updates === "all" || updates === "externalOnly") return true;
  }
  const b = record(call.binding) ?? {};
  if (Array.isArray(b.attendees) && b.attendees.length > 0) return true;
  return b.sendUpdates === "all" || b.sendUpdates === "externalOnly";
}

/**
 * Why this call keeps its usual card in a Full-access chat, or `undefined` when Full access runs
 * it without one. `kind` and `se` are the engine's effective kind and side effect (after floors).
 */
export function fullAccessHold(
  call: PolicyCall,
  kind: ApprovalKind,
  se: SideEffect,
): FullAccessHold | undefined {
  if (se === "financial" || kind === "purchase") return "payment";
  if (SEND_KINDS.includes(kind)) return "send";
  if (kind === "credential_fill") return "credential";
  if (kind === "git_push") return "publish";
  if (SCRIPT_KINDS.includes(kind)) return "script";
  if (SECURITY_KINDS.includes(kind)) return "security";
  if (SEVERITY[se] < SEVERITY.write) return undefined;
  // Any write addressed to a person other than the owner (a recipient target), or that tells
  // attendees about an event: a send, whatever the tool is called.
  if (call.target?.kind === "recipient" && call.target.value !== "owner") {
    return kind === "calendar_write" ? "invite" : "send";
  }
  if (notifiesPeople(call)) return "invite";
  const words = sendWords(call.tool);
  const joined = words.join("_");
  if ([...CONSENT_WORDS].some((w) => words.includes(w) || joined.includes(w))) return "consent";
  // A draft (`mail.reply_draft`, `forward_draft`) waits in the owner's drafts; sending it is a
  // send (`mail_send_draft`).
  if (words.includes("draft") && !words.includes("send")) return undefined;
  if (words.some((w) => SEND_WORDS.has(w))) return "post";
  return undefined;
}
