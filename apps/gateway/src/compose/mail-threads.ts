import { toolName } from "@psyche/connectors";
import type { ReplyItem, SentItem } from "@psyche/memory";
import { readTool, type ToolLookup } from "@psyche/proactive";

/**
 * Mail thread helpers shared by the quiet-thread follow-ups (`mail-followups.ts`) and the promise
 * ledger's done signals (`promise-evidence.ts`): header parsing, thread grouping keys, the shape
 * of connector replies, and looking a connector's tool up by its id.
 *
 * Mail is untrusted. Everything here reads headers and attachment metadata; bodies are never
 * kept.
 */

const AUTOMATED =
  /(^|[<\s.\-_])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|notifications?|newsletter|bounce)([@.\-_>]|$)/i;

export const isAutomatedSender = (who: string): boolean => AUTOMATED.test(who);

/** Gmail's thread ids are opaque hex; anything else is not passed on as an id. */
export const GMAIL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** "Re: Fwd: Lunch?" and "Lunch?" are one thread. */
export const normalizeSubject = (s: string): string =>
  s
    .toLowerCase()
    .replace(/^(\s*(re|fwd?|aw|sv|tr)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim();

/** The bare address of "Name <a@b.c>" or "a@b.c", lower case. */
export function addressOf(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m?.[1] ?? from).trim().toLowerCase();
}

/** "Name <a@b.c>" to "Name"; an address stays an address. */
export function displayName(from: string): string {
  const name = from
    .replace(/<[^>]*>/, "")
    .replace(/["']/g, "")
    .trim();
  return name === "" ? addressOf(from) : name;
}

/** The list a connector reply holds, bare or under `key`. */
export function output<T>(r: unknown, key: string): T[] {
  if (Array.isArray(r)) return r as T[];
  const inner = (r as Record<string, unknown> | null)?.[key];
  return Array.isArray(inner) ? (inner as T[]) : [];
}

export const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const ms = (v: unknown): number => (typeof v === "string" ? Date.parse(v) : Number.NaN);

// --- connectors by id --------------------------------------------------------------------------

/** A connector from the registry: its id, its type and whether it is connected. */
export interface ConnectorRef {
  id: string;
  type: string;
  status: string;
}

/** Connector types that serve mail and calendars. Anything else (custom, MCP) is never read. */
export const MAIL_CONNECTOR_TYPES: ReadonlySet<string> = new Set([
  "apple:mail",
  "google",
  "microsoft",
  "imap",
  "jmap",
]);
export const CALENDAR_CONNECTOR_TYPES: ReadonlySet<string> = new Set([
  "apple:calendar",
  "google",
  "microsoft",
]);

/** The connected connectors of the given types, in registry order. */
export function connectorsOf(
  list: readonly ConnectorRef[],
  types: ReadonlySet<string>,
): ConnectorRef[] {
  return list.filter((c) => c.status === "connected" && types.has(c.type));
}

/**
 * Reads one tool of one connector, by `mcp__<id>__<tool>`: never by the bare name, which any
 * connector or MCP server could also register (Night shift W4 review). Returns `undefined` when
 * the connector has no such tool. A failing read throws.
 */
export async function readConnectorTool(
  tools: ToolLookup,
  connectorId: string,
  bare: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return readTool(tools, toolName(connectorId, bare), params);
}

// --- messages as evidence ----------------------------------------------------------------------

/** One mail message reduced to what a done signal needs. */
export interface MailMeta {
  id: string;
  threadKey: string | null;
  from: string;
  to: string[];
  at: number;
  /** The owner wrote it (a Sent mailbox, a SENT label, or the owner's own address). */
  fromOwner: boolean;
  attachments: string[];
  links: string[];
  link?: string;
}

const names = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).flatMap((a): string[] => {
    if (typeof a === "string") return a.trim() === "" ? [] : [a.trim()];
    if (a !== null && typeof a === "object") {
      const o = a as Record<string, unknown>;
      const n = str(o.filename) || str(o.fileName) || str(o.name) || str(o.title);
      // Inline images (signatures, tracking pixels) are not something the owner sent.
      if (o.inline === true || o.isInline === true) return [];
      return n.trim() === "" ? [] : [n.trim()];
    }
    return [];
  });

const splitAddrs = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map((x) => str(x)) : str(v).split(","))
    .map((x) => addressOf(x))
    .filter((x) => x !== "");

/** A connector's message (Gmail, Apple Mail, IMAP) as `MailMeta`; anything malformed is dropped. */
export function parseMailMeta(
  raw: unknown,
  opts: { ownerAddresses: ReadonlySet<string>; threadKey?: string | null; sentBox?: boolean },
): MailMeta | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  const id = str(m.id) || str(m.messageId);
  const at = ms(m.date);
  const from = addressOf(str(m.from));
  if (id === "" || Number.isNaN(at) || from === "") return undefined;
  const labels = Array.isArray(m.labelIds) ? (m.labelIds as unknown[]) : [];
  const fromOwner =
    opts.ownerAddresses.has(from) ||
    opts.sentBox === true ||
    (labels.includes("SENT") && !labels.includes("INBOX"));
  const link = str(m.link);
  return {
    id,
    threadKey: opts.threadKey ?? (str(m.threadId) || null),
    from,
    to: splitAddrs(m.to),
    at,
    fromOwner,
    attachments: names(m.attachments),
    links: names(m.links),
    ...(link === "" ? {} : { link }),
  };
}

/**
 * Mail messages into done-signal evidence. `resolve` maps an address to a person's entity id
 * (null when unknown). The owner's mail becomes a send to each resolved recipient; anyone else's
 * becomes a send by that person.
 */
export function mailEvidence(
  msgs: readonly MailMeta[],
  resolve: (address: string) => string | null,
): { sent: SentItem[]; replies: ReplyItem[] } {
  const sent: SentItem[] = [];
  const replies: ReplyItem[] = [];
  const seen = new Set<string>();
  for (const m of msgs) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const ref = m.link ?? `mail:${m.id}`;
    const to = [...new Set(m.to.map(resolve).filter((x): x is string => x !== null))];
    const sender = m.fromOwner ? null : resolve(m.from);
    sent.push({
      at: m.at,
      channel: "mail",
      ref,
      threadKey: m.threadKey,
      toEntityIds: to,
      ...(sender === null ? {} : { fromEntityId: sender }),
      attachments: m.attachments,
      links: m.links,
    });
    replies.push({
      at: m.at,
      channel: "mail",
      ref,
      threadKey: m.threadKey,
      fromOwner: m.fromOwner,
      ...(sender === null ? {} : { fromEntityId: sender }),
    });
  }
  return { sent, replies };
}
