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
 * - `commerce`: a tool whose name orders, books, rents, subscribes or pays (an MCP server names
 *   its own tools, so the money floor may not see it): the Balanced card, and the payment path
 *   whenever the server's classifier marks it `financial`.
 * - `send`, `invite`, `post`: anything that reaches another person (email, iMessage and other
 *   messages, calendar invites and changes attendees hear about, posts, replies, comments,
 *   shares, issues, links): one tap per send, `once` only.
 * - `ui_send`: a click on a control whose label is a send verb (Send, Post, Reply…).
 * - `credential`: filling a saved login from the vault.
 * - `security`: pairing, policy and permission changes, folder pickers, skill installs, Night
 *   shift applies, leaving plan mode.
 * - `script`: an AppleScript or Shortcut, whose source can send or pay in ways Psyche can't read
 *   (a Shortcut the owner set to allow in Settings is the owner's choice and runs).
 * - `publish`: a git push (commits published with the owner's credentials).
 * - `consent`: accepting terms or granting an OAuth consent on the owner's behalf.
 * - `runs_later`, `taint_egress`, `taint_submit`: decided in the engine (code that runs later,
 *   reach-out after untrusted content).
 */
export type FullAccessHold =
  | "payment"
  | "commerce"
  | "send"
  | "invite"
  | "post"
  | "ui_send"
  | "credential"
  | "security"
  | "script"
  | "publish"
  | "consent"
  | "runs_later"
  | "taint_egress"
  | "taint_submit";

/** The holds that are sends to other people: their cards offer `once` only (owner's rule). */
export const FULL_ACCESS_SEND_HOLDS: readonly FullAccessHold[] = [
  "send",
  "invite",
  "post",
  "ui_send",
];

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

/** Verbs that send whatever the rest of the name says. */
const SEND_VERBS = new Set([
  "send",
  "post",
  "publish",
  "tweet",
  "retweet",
  "reply",
  "respond",
  "comment",
  "share",
  "invite",
  "forward",
  "dm",
  "broadcast",
  "announce",
  "notify",
  "dispatch",
  "deliver",
  "submit",
  "ping",
]);

/** Channels to other people: a write to one is a send (`create_message`, `chat_update`, `sms`). */
const SEND_NOUNS = new Set(["message", "messages", "email", "emails", "mail", "chat", "sms"]);

/**
 * Things other people see once created or changed (`create_issue`, `create_status`,
 * `permissions_create`): a send only with a creating or changing verb, so `screenshare_status`
 * stays ordinary.
 */
const SHARED_NOUNS = new Set([
  "issue",
  "issues",
  "status",
  "statuses",
  "permission",
  "permissions",
]);

const CREATE_VERBS = new Set([
  "create",
  "new",
  "add",
  "open",
  "update",
  "set",
  "edit",
  "patch",
  "put",
  "write",
  "grant",
]);

/** Words that organise the owner's own mail or messages rather than send (`mail.move`). */
const ORGANISE_WORDS = new Set([
  "move",
  "flag",
  "flags",
  "archive",
  "label",
  "labels",
  "mark",
  "save",
  "attachments",
  "sort",
  "organize",
  "mailboxes",
]);

/** Ordering, booking, renting or paying, by name (`mcp__doordash__create_order`). */
const COMMERCE_WORDS = new Set([
  "order",
  "orders",
  "book",
  "booking",
  "reserve",
  "reservation",
  "ride",
  "rent",
  "rental",
  "subscribe",
  "subscription",
  "upgrade",
  "renew",
  "tip",
  "checkout",
  "cart",
  "purchase",
  "buy",
  "pay",
  "payment",
  "donate",
  "bid",
  "invoice",
  "charge",
  "refund",
]);

/** Calendar operations on an existing event that its attendees hear about. */
const CHANGE_WORDS = new Set([
  "update",
  "delete",
  "cancel",
  "move",
  "reschedule",
  "patch",
  "edit",
  "remove",
]);

/** Labels of a control a click would send with (`Send`, `Post reply`). */
const SEND_LABEL_WORDS = new Set([
  "send",
  "post",
  "reply",
  "tweet",
  "publish",
  "share",
  "invite",
  "submit",
  "forward",
  "comment",
]);

/**
 * The lower-cased word segments of a name, NFKC-folded (an MCP server picks its own names, so
 * `ｓｅｎｄ` is `send`): `mcp__slack__chat.postMessage` gives `mcp slack chat post message`.
 * Splits on `_ . - /`, spaces and camelCase humps; segments are compared whole, never as
 * substrings, so `create_note` and `postgres_query` stay ordinary.
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

const PEOPLE_KEYS = [
  "attendees",
  "invitees",
  "guests",
  "participants",
  "optionalAttendees",
  "requiredAttendees",
  "attendee_emails",
  "attendeeEmails",
];
const UPDATE_KEYS = ["sendUpdates", "send_updates", "sendNotifications", "notifyAttendees"];

function scopes(call: PolicyCall): Record<string, unknown>[] {
  const p = record(call.params) ?? {};
  return [p, record(p.event) ?? {}, record(call.binding) ?? {}];
}

/** A call that names other people to notify: attendees, invitees, or updates sent to them. */
function notifiesPeople(call: PolicyCall): boolean {
  for (const scope of scopes(call)) {
    for (const k of PEOPLE_KEYS) {
      const v = scope[k];
      if (Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.trim() !== "") return true;
    }
    for (const k of UPDATE_KEYS) {
      const u = scope[k];
      if (u === true || u === "all" || u === "externalOnly" || u === "external_only") return true;
    }
  }
  return false;
}

/**
 * A Google calendar connector's call (instance `google` or `google-<n>`, with the connector's own
 * action key and no MCP tier: an MCP server can't name itself one).
 */
function googleConnector(call: PolicyCall): boolean {
  return (
    call.meta?.mcpTier === undefined &&
    call.connectorRule !== undefined &&
    /^google(-[a-z0-9-]+)?$/.test(call.connectorRule.id)
  );
}

/**
 * The call says outright that nobody is told: only Google's `sendUpdates: "none"`, which its
 * executor passes to the Calendar API. Microsoft Graph and Apple Calendar ignore such keys, and
 * the params are the model's, so no other key or tool is believed.
 */
function updatesOff(call: PolicyCall): boolean {
  if (!googleConnector(call)) return false;
  const p = record(call.params) ?? {};
  return p.sendUpdates === "none";
}

/**
 * The chat thread a run's Full access belongs to: a subagent's thread (`<parent>:sub:<id>`, any
 * depth) answers to the owner's chat it was spawned from.
 */
export function fullAccessThreadOf(threadId: string): string {
  const i = threadId.indexOf(":sub:");
  return i < 0 ? threadId : threadId.slice(0, i);
}

/** A control's own label that is a send verb (`Send`, `Post reply`), not a paragraph. */
export function isSendLabel(label: unknown): boolean {
  if (typeof label !== "string") return false;
  const words = sendWords(label);
  return words.length > 0 && words.length <= 4 && words.some((w) => SEND_LABEL_WORDS.has(w));
}

/** A text box whose Enter sends (`Message #general`, `Reply…`, `Write a comment`). */
const MESSAGE_BOX_WORDS = new Set(["message", "reply", "comment", "chat", "tweet", "post"]);

/**
 * An action (browser or computer use) the Gateway read as a send: a click on a control whose own
 * label is a send verb, Enter in a message box, or the executor's own `sends` fact (Return in
 * Messages, a menu item named Send). Only the control's own label counts (and the far end of a
 * drag): a click inside a window titled "Share" is not a send.
 */
export function sendControl(call: PolicyCall): boolean {
  const control = call.meta?.control;
  if (control?.sends === true) return true;
  const own = [control?.labels?.[0], ...(control?.alsoLabels ?? [])];
  if (call.tool === "browser.press") {
    const keys = record(call.params)?.keys;
    const enter = typeof keys === "string" && /(^|[\s+])enter($|\s)/i.test(keys);
    return (
      enter &&
      own.some((l) => typeof l === "string" && sendWords(l).some((w) => MESSAGE_BOX_WORDS.has(w)))
    );
  }
  const click =
    /^(browser|computer)\.(click|double_click)$/.test(call.tool) ||
    (call.tool.startsWith("computer.") && call.meta?.action === "click");
  return click && own.some(isSendLabel);
}

/** A Shortcut being run, whatever names it (`shortcuts_run`, `node.shortcuts.run`, MCP). */
export function runsShortcut(call: PolicyCall, kind: ApprovalKind): boolean {
  if (kind === "shortcut_run") return true;
  const words = [...sendWords(call.tool), ...sendWords(call.connectorRule?.action ?? "")];
  return (words.includes("shortcut") || words.includes("shortcuts")) && words.includes("run");
}

/**
 * Why this call keeps its usual card in a Full-access chat, or `undefined` when Full access runs
 * it without one. `kind` and `se` are the engine's effective kind and side effect (after floors).
 * `ownerAllowed` is the owner's own `allow` for the call in Settings → Connectors.
 */
export function fullAccessHold(
  call: PolicyCall,
  kind: ApprovalKind,
  se: SideEffect,
  ownerAllowed = false,
): FullAccessHold | undefined {
  if (se === "financial" || kind === "purchase") return "payment";
  if (SEND_KINDS.includes(kind)) return "send";
  if (kind === "credential_fill") return "credential";
  if (kind === "git_push") return "publish";
  if (kind === "apple_script") return "script";
  if (runsShortcut(call, kind)) return ownerAllowed ? undefined : "script";
  if (SCRIPT_KINDS.includes(kind)) return "script";
  if (SECURITY_KINDS.includes(kind)) return "security";
  if (SEVERITY[se] < SEVERITY.write) return undefined;
  if (sendControl(call)) return "ui_send";
  // Any write addressed to a person other than the owner (a recipient target), or that tells
  // attendees about an event: a send, whatever the tool is called.
  if (call.target?.kind === "recipient" && call.target.value !== "owner") {
    return kind === "calendar_write" ? "invite" : "send";
  }
  if (notifiesPeople(call)) return "invite";
  const words = sendWords(call.tool);
  const joined = words.join("_");
  // A change to an existing event reaches its attendees unless the call says nobody is told
  // (Microsoft Graph always tells them; a delete cancels the meeting for them).
  const calendar = kind === "calendar_write" || words.includes("calendar");
  if (calendar && words.some((w) => CHANGE_WORDS.has(w)) && !updatesOff(call)) return "invite";
  if (
    ["consent", "oauth_consent", "accept_terms"].some(
      (w) => words.includes(w) || joined.includes(w),
    )
  )
    return "consent";
  // Psyche's own browser and computer-use tools name an action, not what it reaches
  // (`browser.submit`, `computer.type`): a send there is a click on a send control (`ui_send`,
  // above), a payment the money rules', reach-out after untrusted content the engine's holds.
  if (/^(browser|computer)\./.test(call.tool)) return undefined;
  if (words.some((w) => COMMERCE_WORDS.has(w))) return "commerce";
  // A draft (`mail.reply_draft`, `forward_draft`) waits in the owner's drafts; sending it is a
  // send (`mail_send_draft`).
  if (words.includes("draft") && !words.includes("send")) return undefined;
  if (words.some((w) => SEND_VERBS.has(w))) return "post";
  if (words.includes("pull") && words.includes("request")) return "post";
  if (words.includes("link") && (words.includes("shared") || words.includes("share")))
    return "post";
  if (words.some((w) => SEND_NOUNS.has(w)) && !words.some((w) => ORGANISE_WORDS.has(w)))
    return "post";
  if (words.some((w) => SHARED_NOUNS.has(w)) && words.some((w) => CREATE_VERBS.has(w)))
    return "post";
  return undefined;
}
