import type { ApprovalKind } from "@psyche/protocol";
import { isMoneyText, isMoneyToolName } from "@psyche/protocol/money-intent";
import { SEND_KINDS } from "./connector-matrix.ts";
import { AUTH_KINDS, DEVICE_ONLY_KINDS, inferApprovalKind, SEVERITY } from "./kinds.ts";
import type {
  PolicyCall,
  PolicyDecision,
  StagedApplyChildInput,
  StagedApplyRefusalReason,
} from "./types.ts";

/**
 * Per-child rules of `requestStagedApply` (docs/design/night-shift-2026.md §3.1, §3.2, §5.4).
 * Pure: the broker passes the child and the decision it just made, and gets back why the child
 * is left out of the approval, or undefined when it may stay.
 */

/**
 * Tools that may carry a send, by exact full name (night-shift §3.2). A `kind` label never makes
 * a tool a send, so `mail_delete` labelled `send_email` meets the destructive rule instead.
 */
export const STAGED_SEND_TOOLS: ReadonlySet<string> = new Set([
  "mail_send_draft",
  "gmail_send",
  "node.mail.send_draft",
]);

interface UndoTool {
  /** The tool's own id fields; the one(s) present must hold the created id. */
  idKeys: readonly string[];
  /** Other fields the call may carry, each with the only value it may have. */
  extras: Readonly<Record<string, "calendar" | readonly string[]>>;
}

/**
 * Destructive tools an undo may call, by exact full name, with every field they may carry. An
 * undo selects one thing by id and nothing else: any other selector refuses (night-shift §5.4).
 */
const UNDO_TOOLS: Readonly<Record<string, UndoTool>> = {
  calendar_delete_event: {
    idKeys: ["id", "eventId"],
    extras: { span: ["this"], sendUpdates: ["none"], calendarId: "calendar" },
  },
  reminders_delete: { idKeys: ["id"], extras: {} },
};

/**
 * The bare tool name a registered name stands for, or the name itself when it is not a
 * connector's. A connector's tools register as `mcp__<id>__<tool>` (`toolName` in the connector
 * registry, which replaces characters outside `[a-z0-9-]` in the id); only an id in the live
 * `connectorIds` unwraps. Any other `mcp__` name (a third-party MCP server) is returned as it is,
 * so it never equals a bare list entry.
 */
export function bareToolName(tool: string, connectorIds: ReadonlySet<string>): string {
  const m = /^mcp__([a-z0-9-]*)__(.+)$/.exec(tool);
  if (m === null) return tool;
  const seg = m[1] ?? "";
  for (const id of connectorIds) {
    if (id.replace(/[^a-z0-9-]/g, "-") === seg) return m[2] ?? tool;
  }
  return tool;
}

const MAX_STRINGS = 500;
const MAX_DEPTH = 8;

/** Every string a call carries (params, keys and extras), bounded, for the money-intent text check. */
export function callStrings(
  params: unknown,
  extra: readonly (string | undefined)[] = [],
): { strings: string[]; truncated: boolean } {
  const out: string[] = extra.filter((s): s is string => typeof s === "string");
  let truncated = false;
  const walk = (v: unknown, depth: number): void => {
    if (out.length >= MAX_STRINGS || depth > MAX_DEPTH) {
      truncated = true;
      return;
    }
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (typeof v === "object" && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        out.push(k);
        walk(x, depth + 1);
      }
    }
  };
  walk(params, 0);
  return { strings: out, truncated };
}

/** The bare, lower-cased address of `Name <a@b.c>` or `a@b.c`, as the mail connectors canonicalise it. */
export function bareAddress(value: string): string {
  const v = value.trim();
  const m = /^(.*?)\s*<([^<>]+)>$/.exec(v);
  return (m === null ? v : (m[2] ?? "")).trim().toLowerCase();
}

/** Bare addresses of a string or a list of them; `split` also cuts each on `,` (a send target). */
function addresses(v: unknown, split = false): string[] {
  const list = typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
  return list
    .filter((x): x is string => typeof x === "string")
    .flatMap((x) => (split ? x.split(",") : [x]))
    .map(bareAddress);
}

function paramsOf(call: PolicyCall): Record<string, unknown> | undefined {
  const p = call.params;
  return typeof p === "object" && p !== null && !Array.isArray(p)
    ? (p as Record<string, unknown>)
    : undefined;
}

/**
 * Who a send goes to, from the call itself: `to`, `cc`, `bcc` and a recipient target, normalised,
 * lower-cased, de-duplicated, in order. The caller's own list never decides it.
 */
export function callRecipients(call: PolicyCall): string[] {
  const p = paramsOf(call) ?? {};
  const out = [
    ...addresses(p.to),
    ...addresses(p.cc),
    ...addresses(p.bcc),
    ...(call.target?.kind === "recipient" ? addresses(call.target.value, true) : []),
  ].filter((x) => x !== "");
  return [...new Set(out)];
}

/** Whether one call is a well-formed undo delete of `undo.createdId` and nothing else. */
function undoBound(
  call: PolicyCall,
  undo: NonNullable<StagedApplyChildInput["undo"]>,
  connectorIds: ReadonlySet<string>,
): boolean {
  const bare = bareToolName(call.tool, connectorIds);
  const spec = Object.hasOwn(UNDO_TOOLS, bare) ? UNDO_TOOLS[bare] : undefined;
  const created = undo.createdId;
  if (spec === undefined || typeof created !== "string" || created === "") return false;
  const p = paramsOf(call);
  if (p === undefined) return false;
  // An `account` target only names the connector (every real delete carries one): it says
  // nothing about the item, so it is ignored. Any other target kind must be the created id.
  const target = call.target?.kind === "account" ? undefined : call.target?.value;
  const ids = spec.idKeys.filter((k) => k in p);
  if (ids.length === 0 && target === undefined) return false;
  // The id the tool reads, and the target, are the created id: values only, never key names.
  if (ids.some((k) => p[k] !== created)) return false;
  if (target !== undefined && target !== created) return false;
  for (const [k, v] of Object.entries(p)) {
    if (spec.idKeys.includes(k)) continue;
    const allowed = Object.hasOwn(spec.extras, k) ? spec.extras[k] : undefined;
    if (allowed === undefined || typeof v !== "string") return false;
    if (allowed === "calendar") {
      if (undo.calendarId === undefined || v !== undo.calendarId) return false;
    } else if (!allowed.includes(v)) return false;
  }
  return true;
}

/**
 * Reminder tools, by exact name: the Apple, Google Tasks and Microsoft To Do connectors all
 * register these bare names. A reminder can't move money, so its words are not scanned for money
 * text (owner decision 2026-11-24). Its tool name and every other rule still apply, and a
 * prefixed or MCP name (`stripe.reminders_create`) is scanned like any other tool.
 */
const REMINDER_TOOLS: ReadonlySet<string> = new Set([
  "reminders_create",
  "reminders_update",
  "reminders_complete",
]);
export function isReminderTool(tool: string, connectorIds: ReadonlySet<string>): boolean {
  return REMINDER_TOOLS.has(bareToolName(tool, connectorIds));
}

/** The money check of §3.1: tool name, summary, and every string the call carries, both forms. */
export function stagedMoneyIntent(
  child: StagedApplyChildInput,
  decided: PolicyCall,
  connectorIds: ReadonlySet<string>,
): boolean {
  if (isMoneyToolName(decided.tool) || isMoneyToolName(child.call.tool)) return true;
  // A reminder's words (a title like "Pay rent") are skipped: both forms must be a reminder tool.
  if (isReminderTool(decided.tool, connectorIds) && isReminderTool(child.call.tool, connectorIds)) {
    return false;
  }
  if (isMoneyText(child.summary)) return true;
  // The call as given and as the hooks rewrote it: either one looking like a payment refuses.
  for (const c of [child.call, decided]) {
    const { strings, truncated } = callStrings(c.params, [c.target?.value]);
    // A call too big to read in full fails closed.
    if (truncated) return true;
    if (strings.some((x) => isMoneyText(x))) return true;
  }
  return false;
}

/** The kinds a child can be read as: the resolved, the decision's, the declared and the inferred. */
export function stagedKinds(
  child: StagedApplyChildInput,
  d: PolicyDecision,
  kind: ApprovalKind,
): Set<ApprovalKind> {
  return new Set<ApprovalKind>([
    kind,
    ...(d.approvalKind === undefined ? [] : [d.approvalKind]),
    ...(child.call.kind === undefined ? [] : [child.call.kind]),
    inferApprovalKind(child.call.tool),
    inferApprovalKind(d.call.tool),
  ]);
}

/** Whether a kept child is a send (by its exact tool name; a send never passes any other way). */
export function isStagedSend(
  child: StagedApplyChildInput,
  d: PolicyDecision,
  connectorIds: ReadonlySet<string>,
): boolean {
  return (
    d.call.tool === child.call.tool &&
    STAGED_SEND_TOOLS.has(bareToolName(d.call.tool, connectorIds))
  );
}

export interface StagedVerdict {
  reason: StagedApplyRefusalReason;
  message: string;
}

const SEND_NOT_EXPLICIT: StagedVerdict = {
  reason: "send_not_explicit",
  message: "a send needs its own tick and its recipients",
};

/**
 * Why a decided child is refused, or undefined when it may be part of the approval.
 * `kind` is the broker's resolved kind; the declared and inferred kinds are checked too, so a
 * relabelled call (`kind: "file_write"` on a send) still meets every rule.
 */
export function refuseStagedChild(
  child: StagedApplyChildInput,
  d: PolicyDecision,
  kind: ApprovalKind,
  connectorIds: ReadonlySet<string>,
): StagedVerdict | undefined {
  const tool = d.call.tool;
  const kinds = stagedKinds(child, d, kind);
  const any = (list: readonly ApprovalKind[]): boolean => [...kinds].some((k) => list.includes(k));
  const se = d.sideEffect;

  // §3.1.
  if (stagedMoneyIntent(child, d.call, connectorIds)) {
    return { reason: "money_intent", message: "this looks like a payment" };
  }
  if (d.decision === "deny") {
    return { reason: "denied", message: `denied: ${d.reason ?? d.rule}` };
  }
  if (se === "financial" || child.call.sideEffect === "financial") {
    return { reason: "financial", message: "payments are never applied in bulk" };
  }
  if (kinds.has("purchase")) {
    return { reason: "purchase", message: "purchases are never applied in bulk" };
  }
  if (any(AUTH_KINDS)) {
    return { reason: "authentication", message: "this needs its own approval" };
  }
  if (d.typedConfirmation !== undefined) {
    return { reason: "typed_confirmation", message: "this needs a typed confirmation" };
  }
  if (kinds.has("batch") || kinds.has("staged_apply")) {
    return { reason: "nested_approval", message: "an approval can't hold another approval" };
  }
  if (any(DEVICE_ONLY_KINDS)) {
    return { reason: "device_only_kind", message: "this needs its own approval on the Mac" };
  }

  // §3.2: a send is allowed only on a send tool's exact name, with the kind the registry gives
  // it, when the owner ticked it and the recipients are the call's own.
  const sendKind = any(SEND_KINDS);
  if (isStagedSend(child, d, connectorIds)) {
    const own = callRecipients(d.call);
    const given = [
      ...new Set(
        (child.recipients ?? []).map((r) => (typeof r === "string" ? bareAddress(r) : "")),
      ),
    ];
    const explicit =
      child.explicitSend === true &&
      child.undo === undefined &&
      kinds.has("send_email") &&
      !kinds.has("message_send") &&
      own.length > 0 &&
      given.length === own.length &&
      own.every((r) => given.includes(r));
    return explicit ? undefined : SEND_NOT_EXPLICIT;
  }
  // A send kind on any other tool never passes: a label does not make a tool a send. Messages
  // and the like are not stageable.
  if (sendKind && SEVERITY[se] < SEVERITY.destructive) return SEND_NOT_EXPLICIT;

  // §5.4: a destructive child is only an undo of something Night shift created.
  if (SEVERITY[se] >= SEVERITY.destructive) {
    if (child.undo === undefined) {
      return { reason: "destructive", message: "deletes are never applied in bulk" };
    }
    if (
      sendKind ||
      !undoBound(child.call, child.undo, connectorIds) ||
      !undoBound(d.call, child.undo, connectorIds)
    ) {
      return {
        reason: "undo_unbound",
        message: "an undo may only delete what Night shift created",
      };
    }
    return undefined;
  }
  if (se !== "write") {
    return { reason: "not_write", message: `only changes can be applied (${tool})` };
  }
  return undefined;
}
