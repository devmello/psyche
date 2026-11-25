import type {
  ApprovalKind,
  ConnectorRule,
  SideEffect,
  StagedCall,
  Staging,
  StagingRun,
  StagingSink,
  Target,
} from "@psyche/protocol";
import { isMoneyText, isMoneyToolName } from "@psyche/protocol/money-intent";

/**
 * Staging runs (docs/design/night-shift-2026.md §2.2, §2.3, §3.1). A staging run prepares changes
 * for the owner's morning review: reads run, an allowlisted write is recorded through a
 * `StagingSink` and does not happen, every other write is refused. This module holds the sink
 * interface (re-exported from the protocol contract), the exact-name allowlist and the
 * never-staged rules. The loop's `#gate` calls `stageVerdict` after the broker decided and before
 * anything dispatches or asks.
 *
 * Fork a plan reuses the same gate (fork-a-plan-2026.md §3.1): there is one allowlist and one set
 * of rules, and only the sink and the refusal note differ by `Staging.kind`.
 */
export type { StagedCall, Staging, StagingRun, StagingSink };

/** A staged write: the connector tool's bare name and the connector actions it may carry. */
interface Stageable {
  domain: "mail" | "calendar" | "reminders" | "files";
  /** The connector action-matrix keys the tool is registered under (`connectorRule.action`). */
  actions: readonly string[];
}

/**
 * Exact bare tool names (§2.3). The registered name is `mcp__<connector id>__<bare name>` and the
 * call must also carry a connector rule whose id is that connector and whose action is one of the
 * listed ones: an MCP server's tool with the same name has no connector rule and is refused.
 *
 * Not here on purpose: `mail_send`, `mail_send_draft` and `gmail_send` (the send recipe is the
 * system's, §3.2, never the model's), forward drafts, every delete, Messages, notes and file
 * writes, MCP tools and everything in §3.1.
 */
export const STAGEABLE_TOOLS: ReadonlyMap<string, Stageable> = new Map<string, Stageable>([
  ["mail_reply_draft", { domain: "mail", actions: ["mail.draft"] }],
  ["mail_draft", { domain: "mail", actions: ["mail.draft"] }],
  ["mail_create_draft", { domain: "mail", actions: ["mail.draft"] }],
  ["gmail_create_draft", { domain: "mail", actions: ["gmail.draft"] }],
  ["calendar_create_event", { domain: "calendar", actions: ["calendar.write"] }],
  ["calendar_update_event", { domain: "calendar", actions: ["calendar.write"] }],
  ["reminders_create", { domain: "reminders", actions: ["reminders.write"] }],
  ["reminders_update", { domain: "reminders", actions: ["reminders.write"] }],
  ["reminders_complete", { domain: "reminders", actions: ["reminders.write"] }],
  ["files_move", { domain: "files", actions: ["files.organize"] }],
  ["files_rename", { domain: "files", actions: ["files.organize"] }],
]);

/**
 * Approval kinds that need presence or a device (`AUTH_KINDS` in `@psyche/permissions`, which this
 * package cannot import; `apps/gateway/test/staging-auth-kinds.test.ts` keeps the two in step),
 * plus the kinds that are sends or bulk applies. Never staged.
 */
export const NEVER_STAGED_KINDS: readonly ApprovalKind[] = [
  "credential_fill",
  "purchase",
  "exec_host",
  "pairing",
  "policy_change",
  "apple_script",
  "send_email",
  "message_send",
  "batch",
  "staged_apply",
];

/** A staged write must describe itself as one of these (or as nothing). */
const STAGEABLE_KINDS: readonly ApprovalKind[] = [
  "connector_action",
  "calendar_write",
  "file_write",
];

/** Tools a staging run never gets to use for delegation or standing effects, whatever they say. */
const DELEGATION_TOOLS: ReadonlySet<string> = new Set([
  "task.start",
  "specialist.spawn",
  "schedule",
  "notify",
]);

export type StageRefusal =
  | "not_allowlisted"
  | "not_a_connector_tool"
  | "side_effect"
  | "kind"
  | "money"
  | "delete"
  | "recipient"
  | "attendees"
  | "unreadable_args";

export type StageVerdict =
  | { stage: true; connector: { id: string; action: string } }
  | { stage: false; reason: StageRefusal };

export interface StageCheckInput {
  /** The registered tool name. */
  tool: string;
  /** The stricter of the spec's and the call's side effect. */
  sideEffect: SideEffect;
  /** The call's own approval kind (`describeCall`). */
  kind?: ApprovalKind | undefined;
  /** The kind the broker asked for, when it decided `ask`. */
  approvalKind?: ApprovalKind | undefined;
  target?: Target | undefined;
  summary?: string | undefined;
  /** The frozen arguments. */
  args: unknown;
  connectorRule?: ConnectorRule | undefined;
}

const CONNECTOR_TOOL = /^mcp__([a-z0-9-]+)__(.+)$/;
const DELETE_WORDS =
  /(^|[^a-z])(delete|trash|remove|destroy|erase|purge|wipe|forget|cancel)([^a-z]|$)/i;
/** Argument keys that name people a message or an event reaches. */
const RECIPIENT_KEYS = new Set([
  "to",
  "cc",
  "bcc",
  "recipients",
  "recipient",
  "forward",
  "forwardto",
]);
const ATTENDEE_KEYS = new Set(["attendees", "invitees", "guests", "attendee", "invitee", "guest"]);
const STRING_BUDGET = 400;
const DEPTH_BUDGET = 12;

/** Splits `mcp__<id>__<tool>`; `undefined` for anything else. */
export function connectorToolName(name: string): { id: string; tool: string } | undefined {
  const m = CONNECTOR_TOOL.exec(name);
  return m === null ? undefined : { id: m[1] as string, tool: m[2] as string };
}

function nonEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.some(nonEmpty);
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

interface Walk {
  strings: string[];
  keys: Set<string>;
  /** Keys (lower-cased) that carry a non-empty value anywhere in the arguments. */
  filled: Set<string>;
  ok: boolean;
}

/** Every string value and key of the arguments, bounded: an oversized or cyclic input fails closed. */
function walk(value: unknown): Walk {
  const out: Walk = { strings: [], keys: new Set(), filled: new Set(), ok: true };
  const seen = new Set<object>();
  const visit = (v: unknown, depth: number): void => {
    if (!out.ok) return;
    if (depth > DEPTH_BUDGET || out.strings.length > STRING_BUDGET) {
      out.ok = false;
      return;
    }
    if (typeof v === "string") {
      out.strings.push(v);
      return;
    }
    if (v === null || typeof v !== "object") return;
    if (seen.has(v)) {
      out.ok = false;
      return;
    }
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
    } else {
      for (const [k, item] of Object.entries(v)) {
        const key = k.toLowerCase().replace(/[^a-z]/g, "");
        out.keys.add(key);
        if (nonEmpty(item)) out.filled.add(key);
        out.strings.push(k);
        visit(item, depth + 1);
      }
    }
    seen.delete(v);
  };
  visit(value, 0);
  return out;
}

/**
 * Whether a write may be staged (§2.3) and the never-staged rules (§3.1), in one place. The gate
 * calls it for every call that is not a read and whose decision was not `deny`. It runs the
 * never-staged rules first, then the exact allowlist, so a near-miss is refused for the stronger
 * reason and a money tool never reaches an adapter.
 */
export function stageVerdict(input: StageCheckInput): StageVerdict {
  const refuse = (reason: StageRefusal): StageVerdict => ({ stage: false, reason });
  const named = connectorToolName(input.tool);
  const bare = named?.tool ?? input.tool;

  // §3.1: financial, purchase, every AUTH_KINDS kind, money intent, deletes.
  if (input.sideEffect === "financial") return refuse("money");
  for (const kind of [input.kind, input.approvalKind]) {
    if (kind !== undefined && NEVER_STAGED_KINDS.includes(kind)) return refuse("kind");
  }
  if (
    isMoneyToolName(input.tool) ||
    isMoneyToolName(bare) ||
    isMoneyText(bare.replace(/[_-]+/g, " ")) ||
    isMoneyText(input.summary)
  ) {
    return refuse("money");
  }
  if (input.sideEffect === "destructive" || DELETE_WORDS.test(bare)) return refuse("delete");
  if (DELEGATION_TOOLS.has(input.tool)) return refuse("not_allowlisted");

  const args = walk(input.args);
  if (!args.ok) return refuse("unreadable_args");
  for (const s of args.strings) {
    if (isMoneyText(s)) return refuse("money");
  }

  // The exact allowlist.
  if (named === undefined) return refuse("not_a_connector_tool");
  const entry = STAGEABLE_TOOLS.get(named.tool);
  if (entry === undefined) return refuse("not_allowlisted");
  const rule = input.connectorRule;
  if (rule === undefined || rule.id.replace(/[^a-z0-9-]/g, "-") !== named.id) {
    return refuse("not_a_connector_tool");
  }
  const action = entry.actions.find((a) => rule.action === a || rule.action.startsWith(`${a}/`));
  if (action === undefined) return refuse("not_allowlisted");
  if (input.sideEffect !== "write") return refuse("side_effect");
  for (const kind of [input.kind, input.approvalKind]) {
    if (kind !== undefined && !STAGEABLE_KINDS.includes(kind)) return refuse("kind");
  }

  // Per-domain refusals the gate can see without reading anything (§2.3 "Not stageable").
  if (entry.domain === "mail" && named.tool === "mail_reply_draft") {
    // A reply goes to the thread's own participants: no recipient field may be filled.
    for (const k of args.filled) if (RECIPIENT_KEYS.has(k)) return refuse("recipient");
  }
  if (entry.domain === "calendar") {
    // An event with other attendees notifies people. A call that names any, or that would
    // email updates, or whose description says it invites, is not staged.
    for (const k of args.filled) if (ATTENDEE_KEYS.has(k)) return refuse("attendees");
    if (input.target?.kind === "recipient") return refuse("attendees");
    if (args.filled.has("sendupdates")) {
      const sends = args.strings.some((s) => /^(all|externalonly)$/i.test(s.trim()));
      if (sends) return refuse("attendees");
    }
  }
  return { stage: true, connector: { id: rule.id, action: rule.action } };
}

/** What the model is told. A refusal never says which rule fired. */
export function refusalNote(staging: Staging): string {
  return staging.kind === "fork"
    ? "not prepared in a plan; add it as a step"
    : "can't be prepared overnight";
}

export function stagedNote(staging: Staging): string {
  return staging.kind === "fork"
    ? "recorded in the plan's branch; it has not happened and returns no result"
    : "recorded for the owner's morning review; it has not happened and returns no result";
}

/** The model-facing result of a call the gate staged. */
export function stagedOutput(staging: Staging, stagedId: string) {
  return { staged: true as const, stagedId, note: stagedNote(staging) };
}

/** The model-facing result of a call the gate refused. Nothing ran and no card was raised. */
export function refusedOutput(staging: Staging) {
  return { staged: false as const, note: refusalNote(staging) };
}
