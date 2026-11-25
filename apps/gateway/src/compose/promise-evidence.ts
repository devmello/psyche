import type { CalendarItem, DoneEvidence, ReplyItem, SentItem } from "@psyche/memory";
import type { ToolLookup } from "@psyche/proactive";
import type { Clock, ErrorPayload, NodeClient } from "@psyche/protocol";
import {
  CALENDAR_CONNECTOR_TYPES,
  type ConnectorRef,
  connectorsOf,
  GMAIL_ID,
  MAIL_CONNECTOR_TYPES,
  type MailMeta,
  mailEvidence,
  ms,
  output,
  parseMailMeta,
  readConnectorTool,
  str,
} from "./mail-threads.ts";

/**
 * The readers behind the promise ledger's done signals (design section 4.2): what the owner and
 * the promisee sent each other after the promise, calendar events the owner created with the
 * promisee invited, and Messages attachments. Everything is metadata: addresses, times, file names
 * and attendee ids. No body is kept; `messages.read` has no metadata-only form, so its `text` is
 * dropped the moment the row is mapped.
 *
 * Mail and calendar tools are looked up by connector id (`mcp__<id>__<tool>`) among connected
 * connectors of a mail or calendar type, never by bare name. A failed read yields no evidence:
 * a promise is never closed on a guess.
 */

/** The Mac helper's client, as the Messages reader uses it: only `invoke`. */
export type EvidenceHelper = Pick<NodeClient, "invoke">;

/** The promisee as the readers need them: the ledger's entity and the ways to reach them. */
export interface EvidencePerson {
  entityId: string;
  addresses: string[];
  /** Messages handles (phone numbers, Apple ids). */
  handles: string[];
}

export interface EvidenceDeps {
  clock: Clock;
  tools: () => ToolLookup | undefined;
  connectors: () => readonly ConnectorRef[] | Promise<readonly ConnectorRef[]>;
  /** The live Mac helper for Messages; undefined while none is connected. */
  helper?: () => EvidenceHelper | undefined;
  /** The owner's own addresses, lower case. */
  ownerAddresses: () => ReadonlySet<string>;
  /** An address or handle to a person's entity id, or null when it is nobody the owner knows. */
  resolve: (contact: string) => string | null;
  logger?: { log(level: "warn", msg: string, fields?: Record<string, unknown>): void };
}

export interface EvidenceQuery {
  person: EvidencePerson;
  /** The promise's source thread (mail thread key, chat id), when it has one. */
  threadKey: string | null;
  sinceMs: number;
  /** Upper bound for calendar events created for later. */
  calendarDays?: number;
}

const DAY_MS = 86_400_000;
const MAX_THREADS = 5;
const MAX_READS = 5;
const MESSAGES_PAGE = 50;
const MESSAGES_TIMEOUT_MS = 20_000;

const safeAddress = (a: string): boolean => /^[A-Za-z0-9._%+@-]{3,254}$/.test(a);
const gmailDate = (t: number): string => new Date(t).toISOString().slice(0, 10).replace(/-/g, "/");

// --- mail -------------------------------------------------------------------------------------

async function readMail(
  deps: EvidenceDeps,
  tools: ToolLookup,
  q: EvidenceQuery,
  connectors: readonly ConnectorRef[],
): Promise<MailMeta[]> {
  const owner = deps.ownerAddresses();
  const out: MailMeta[] = [];
  const wanted = new Set(q.person.addresses.map((a) => a.toLowerCase()).filter(safeAddress));
  const involves = (m: MailMeta): boolean => wanted.has(m.from) || m.to.some((a) => wanted.has(a));
  const safe = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      deps.logger?.log("warn", "promise evidence read failed", {
        source: label,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  };
  for (const c of connectorsOf(connectors, MAIL_CONNECTOR_TYPES)) {
    if (c.type === "google") {
      const threadIds = new Set<string>();
      if (q.threadKey !== null && GMAIL_ID.test(q.threadKey)) threadIds.add(q.threadKey);
      const addrs = [...wanted].slice(0, 3);
      if (addrs.length > 0) {
        const query = `after:${gmailDate(q.sinceMs)} (${addrs.map((a) => `from:${a} OR to:${a}`).join(" OR ")})`;
        const found = await safe("gmail_search_threads", () =>
          readConnectorTool(tools, c.id, "gmail_search_threads", {
            query,
            maxResults: MAX_THREADS,
          }),
        );
        for (const t of output<{ id?: unknown }>(found, "threads"))
          if (GMAIL_ID.test(str(t.id)) && str(t.id) !== "") threadIds.add(str(t.id));
      }
      for (const threadId of [...threadIds].slice(0, MAX_THREADS)) {
        const th = await safe("gmail_read_thread", () =>
          readConnectorTool(tools, c.id, "gmail_read_thread", { threadId }),
        );
        for (const raw of output<unknown>(th, "messages")) {
          const m = parseMailMeta(raw, { ownerAddresses: owner, threadKey: threadId });
          if (m !== undefined) out.push(m);
        }
      }
    } else if (c.type === "apple:mail") {
      const since = new Date(q.sinceMs).toISOString();
      const found = await safe("mail_search", () =>
        readConnectorTool(tools, c.id, "mail_search", { since, limit: 50 }),
      );
      let reads = 0;
      for (const raw of output<Record<string, unknown>>(found, "messages")) {
        const sentBox = /sent/i.test(str(raw.mailbox));
        const m = parseMailMeta(raw, { ownerAddresses: owner, sentBox });
        if (m === undefined || !involves(m)) continue;
        if (m.fromOwner && m.attachments.length === 0 && reads < MAX_READS) {
          reads++;
          const read = await safe("mail_read", () =>
            readConnectorTool(tools, c.id, "mail_read", {
              id: str(raw.id),
              maxLength: 100,
              ...(str(raw.mailbox) === "" ? {} : { mailbox: str(raw.mailbox) }),
              ...(str(raw.account) === "" ? {} : { account: str(raw.account) }),
            }),
          );
          const withFiles = parseMailMeta(
            { ...raw, attachments: (read as Record<string, unknown> | undefined)?.attachments },
            { ownerAddresses: owner, sentBox },
          );
          out.push(withFiles ?? m);
        } else out.push(m);
      }
    } else {
      const found = await safe("mail_search_messages", () =>
        readConnectorTool(tools, c.id, "mail_search_messages", {
          since: new Date(q.sinceMs).toISOString(),
          maxResults: 50,
        }),
      );
      for (const raw of output<Record<string, unknown>>(found, "messages")) {
        const m = parseMailMeta(raw, {
          ownerAddresses: owner,
          sentBox: /sent/i.test(str(raw.mailbox)),
        });
        if (m !== undefined && involves(m)) out.push(m);
      }
    }
  }
  return out.filter((m) => m.at > q.sinceMs);
}

// --- Messages ---------------------------------------------------------------------------------

/**
 * `messages.read` rows to evidence. The owner's message is a send to the person whose chat it is;
 * stickers and voice notes are not deliverables. `text` is never read.
 */
export function messagesEvidence(
  rows: unknown,
  person: Pick<EvidencePerson, "entityId">,
  resolve: (handle: string) => string | null,
): { sent: SentItem[]; replies: ReplyItem[] } {
  const sent: SentItem[] = [];
  const replies: ReplyItem[] = [];
  for (const raw of output<Record<string, unknown>>(rows, "messages")) {
    const guid = str(raw.guid);
    const at = ms(raw.sentAt);
    const isReaction = raw.reaction !== null && raw.reaction !== undefined;
    if (guid === "" || Number.isNaN(at) || isReaction) continue;
    const fromOwner = raw.isFromMe === true;
    const handle = str((raw.sender as Record<string, unknown> | null | undefined)?.handle);
    const sender = fromOwner ? null : resolve(handle);
    const attachments = output<Record<string, unknown>>(raw.attachments, "attachments")
      .filter((a) => a.isSticker !== true && a.isVoiceNote !== true)
      .map((a) => str(a.filename).trim())
      .filter((n) => n !== "");
    const chatId = str(raw.chatId) || null;
    const ref = `messages:${guid}`;
    sent.push({
      at,
      channel: "messages",
      ref,
      threadKey: chatId,
      toEntityIds: fromOwner ? [person.entityId] : [],
      ...(sender === null ? {} : { fromEntityId: sender }),
      attachments,
      links: [],
    });
    replies.push({
      at,
      channel: "messages",
      ref,
      threadKey: chatId,
      fromOwner,
      ...(sender === null ? {} : { fromEntityId: sender }),
    });
  }
  return { sent, replies };
}

async function readMessages(
  deps: EvidenceDeps,
  q: EvidenceQuery,
  signal: AbortSignal,
): Promise<{ sent: SentItem[]; replies: ReplyItem[] }> {
  const empty = { sent: [], replies: [] };
  const client = deps.helper?.();
  if (client === undefined) return empty;
  const sent: SentItem[] = [];
  const replies: ReplyItem[] = [];
  for (const handle of q.person.handles.slice(0, 3)) {
    try {
      const res = await client.invoke(
        "messages.read",
        { handle, limit: MESSAGES_PAGE },
        { signal, timeoutMs: MESSAGES_TIMEOUT_MS },
      );
      if (!res.ok) {
        deps.logger?.log("warn", "promise evidence read failed", {
          source: "messages.read",
          error: helperReason(res.error),
        });
        continue;
      }
      const got = messagesEvidence(res.result, q.person, (h) => deps.resolve(h));
      sent.push(...got.sent.filter((s) => s.at > q.sinceMs));
      replies.push(...got.replies.filter((r) => r.at > q.sinceMs));
    } catch (err) {
      deps.logger?.log("warn", "promise evidence read failed", {
        source: "messages.read",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { sent, replies };
}

const helperReason = (e: ErrorPayload | undefined): string => e?.code ?? "unknown";

// --- calendar ---------------------------------------------------------------------------------

const attendeeAddresses = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).flatMap((a): string[] => {
    const s = typeof a === "string" ? a : str((a as Record<string, unknown> | null)?.email);
    return s.trim() === "" ? [] : [s.trim().toLowerCase()];
  });

/**
 * Calendar events as `CalendarItem`s. An event counts as the owner's when the connector says the
 * owner organised or created it; with no creation time it never qualifies (the rule fails closed).
 */
export function calendarEvidence(
  rows: unknown,
  resolve: (address: string) => string | null,
  connectorId: string,
): CalendarItem[] {
  const out: CalendarItem[] = [];
  for (const raw of output<Record<string, unknown>>(rows, "events")) {
    const id = str(raw.id);
    if (id === "" || raw.status === "cancelled") continue;
    const created = ms(raw.created) || ms(raw.createdAt) || ms(raw.creationDate);
    const org = (raw.organizer ?? {}) as Record<string, unknown>;
    const creator = (raw.creator ?? {}) as Record<string, unknown>;
    const byOwner =
      raw.createdByOwner === true ||
      org.self === true ||
      creator.self === true ||
      raw.isOrganizer === true;
    out.push({
      createdAt: Number.isNaN(created) || created === 0 ? null : created,
      ref: `calendar:${connectorId}:${id}`,
      title: str(raw.summary) || str(raw.title) || "event",
      createdByOwner: byOwner,
      attendeeEntityIds: [
        ...new Set(
          attendeeAddresses(raw.attendees)
            .map(resolve)
            .filter((x): x is string => x !== null),
        ),
      ],
    });
  }
  return out;
}

async function readCalendar(
  deps: EvidenceDeps,
  tools: ToolLookup,
  q: EvidenceQuery,
  connectors: readonly ConnectorRef[],
): Promise<CalendarItem[]> {
  const out: CalendarItem[] = [];
  const to = deps.clock.now() + (q.calendarDays ?? 90) * DAY_MS;
  for (const c of connectorsOf(connectors, CALENDAR_CONNECTOR_TYPES)) {
    try {
      const r = await readConnectorTool(tools, c.id, "calendar_list_events", {
        from: new Date(q.sinceMs).toISOString(),
        to: new Date(Math.min(to, q.sinceMs + 365 * DAY_MS)).toISOString(),
        limit: 200,
      });
      out.push(...calendarEvidence(r, (a) => deps.resolve(a), c.id));
    } catch (err) {
      deps.logger?.log("warn", "promise evidence read failed", {
        source: "calendar_list_events",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** Everything the done rules need for one promise, from every source that is connected. */
export async function collectDoneEvidence(
  deps: EvidenceDeps,
  q: EvidenceQuery,
  signal: AbortSignal = new AbortController().signal,
): Promise<DoneEvidence> {
  const tools = deps.tools();
  const connectors = await deps.connectors();
  const sent: SentItem[] = [];
  const replies: ReplyItem[] = [];
  let events: CalendarItem[] = [];
  if (tools !== undefined) {
    const mail = mailEvidence(await readMail(deps, tools, q, connectors), (a) => deps.resolve(a));
    sent.push(...mail.sent);
    replies.push(...mail.replies);
    events = await readCalendar(deps, tools, q, connectors);
  }
  const chat = await readMessages(deps, q, signal);
  sent.push(...chat.sent);
  replies.push(...chat.replies);
  return { sent, replies, events };
}
