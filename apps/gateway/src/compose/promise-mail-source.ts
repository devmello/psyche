import type { LaneItem } from "@psyche/memory";
import { ownWords } from "@psyche/memory";
import type { ToolLookup } from "@psyche/proactive";
import {
  addressOf,
  type ConnectorRef,
  connectorsOf,
  displayName,
  GMAIL_ID,
  isAutomatedSender,
  MAIL_CONNECTOR_TYPES,
  ms,
  output,
  readConnectorTool,
  str,
} from "./mail-threads.ts";

/**
 * The mail the promise scan reads (design 3.1): the owner's own new text in sent mail, and new
 * text from a person the owner is in two-way touch with. Automated senders and bulk lists are
 * skipped. Bodies are cut to the author's own words before anything else sees them, and are never
 * stored: they live only in the returned items.
 *
 * Mail connectors are read by connector id (`mcp__<id>__<tool>`), never by a bare tool name. A
 * failed read yields nothing for that connector: the cursor then does not move past it.
 */

export interface MailSourceDeps {
  tools: () => ToolLookup | undefined;
  connectors: () => readonly ConnectorRef[] | Promise<readonly ConnectorRef[]>;
  /** An address to the person's entity id, or null for nobody the owner knows. */
  resolve: (address: string) => string | null;
  /** The person's display name in the graph, for the label as written in the source. */
  isTwoWay: (entityId: string) => boolean;
  logger?: { log(level: "warn", msg: string, fields?: Record<string, unknown>): void };
}

const MAX_MESSAGES = 30;
const MAX_RECIPIENTS = 8;
const gmailDate = (t: number): string => new Date(t).toISOString().slice(0, 10).replace(/-/g, "/");

const bodyOf = (raw: Record<string, unknown>): string => {
  const inner = (raw.message ?? raw) as Record<string, unknown>;
  return (
    str(inner.body) ||
    str(inner.text) ||
    str(inner.textBody) ||
    str(inner.snippet) ||
    str(inner.preview)
  );
};

const addrList = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map((x) => str(x)) : str(v).split(","))
    .map((x) => addressOf(x))
    .filter((x) => x !== "");

interface RawMail {
  id: string;
  threadKey: string | null;
  from: string;
  fromLabel: string;
  to: string[];
  at: number;
  fromOwner: boolean;
  text: string;
  link?: string;
}

function toItem(m: RawMail, deps: MailSourceDeps): LaneItem | undefined {
  if (m.text.trim() === "" || isAutomatedSender(m.from)) return undefined;
  const people = new Set([m.from, ...m.to]);
  if (people.size > MAX_RECIPIENTS + 1) return undefined;
  const own = ownWords(m.text);
  if (own.trim() === "") return undefined;
  if (m.fromOwner) {
    // One-to-one up to eight recipients: the counterpart is the one recipient when there is one.
    const known = m.to.map((a) => deps.resolve(a)).filter((x): x is string => x !== null);
    const only = known.length === 1 && m.to.length === 1 ? known[0] : undefined;
    return {
      source: "mail",
      sourceRef: m.link ?? `mail:${m.id}`,
      threadId: m.threadKey,
      author: "owner",
      counterpartId: only ?? null,
      counterpartLabel: only === undefined ? null : (m.to[0] ?? null),
      sentAt: new Date(m.at).toISOString(),
      text: own,
      groupSize: m.to.length + 1,
    };
  }
  const who = deps.resolve(m.from);
  if (who === null || !deps.isTwoWay(who)) return undefined;
  return {
    source: "mail",
    sourceRef: m.link ?? `mail:${m.id}`,
    threadId: m.threadKey,
    author: "counterpart",
    counterpartId: who,
    counterpartLabel: m.fromLabel.slice(0, 80),
    sentAt: new Date(m.at).toISOString(),
    text: own,
    groupSize: m.to.length + 1,
  };
}

/** Mail since `sinceMs`, as lane items, newest cap first. */
export async function readMailItems(deps: MailSourceDeps, sinceMs: number): Promise<LaneItem[]> {
  const tools = deps.tools();
  if (tools === undefined) return [];
  const raws: RawMail[] = [];
  const safe = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      deps.logger?.log("warn", "promise mail read failed", {
        source: label,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  };
  const since = new Date(sinceMs).toISOString();
  for (const c of connectorsOf(await deps.connectors(), MAIL_CONNECTOR_TYPES)) {
    if (c.type === "google") {
      const found = await safe("gmail_search_threads", () =>
        readConnectorTool(tools, c.id, "gmail_search_threads", {
          query: `after:${gmailDate(sinceMs)}`,
          maxResults: 15,
        }),
      );
      for (const t of output<{ id?: unknown }>(found, "threads").slice(0, 15)) {
        const threadId = str(t.id);
        if (!GMAIL_ID.test(threadId)) continue;
        const th = await safe("gmail_read_thread", () =>
          readConnectorTool(tools, c.id, "gmail_read_thread", { threadId }),
        );
        for (const raw of output<Record<string, unknown>>(th, "messages")) {
          const at = ms(raw.date);
          const labels = Array.isArray(raw.labelIds) ? (raw.labelIds as unknown[]) : [];
          if (
            Number.isNaN(at) ||
            at <= sinceMs ||
            labels.includes("SPAM") ||
            labels.includes("TRASH")
          )
            continue;
          raws.push({
            id: str(raw.id),
            threadKey: threadId,
            from: addressOf(str(raw.from)),
            fromLabel: displayName(str(raw.from)),
            to: addrList(raw.to),
            at,
            // The label, never the From header, says it is the owner's.
            fromOwner: labels.includes("SENT") && !labels.includes("INBOX"),
            text: bodyOf(raw),
          });
        }
      }
      continue;
    }
    // Apple Mail, IMAP, JMAP and Outlook share the `mail_*` read tools.
    const apple = c.type === "apple:mail";
    const search = apple ? "mail_search" : "mail_search_messages";
    const read = apple ? "mail_read" : "mail_read_message";
    const found = await safe(search, () =>
      readConnectorTool(tools, c.id, search, {
        since,
        [apple ? "limit" : "maxResults"]: MAX_MESSAGES,
      }),
    );
    for (const raw of output<Record<string, unknown>>(found, "messages").slice(0, MAX_MESSAGES)) {
      const at = ms(raw.date);
      if (Number.isNaN(at) || at <= sinceMs) continue;
      const full = await safe(read, () =>
        readConnectorTool(
          tools,
          c.id,
          read,
          apple
            ? {
                id: str(raw.id),
                maxLength: 4000,
                ...(str(raw.mailbox) ? { mailbox: str(raw.mailbox) } : {}),
              }
            : { id: str(raw.id) },
        ),
      );
      const wrapped = (full as Record<string, unknown> | undefined)?.message;
      const detail = (wrapped !== null && typeof wrapped === "object" ? wrapped : full) as
        | Record<string, unknown>
        | undefined;
      raws.push({
        id: str(raw.id),
        threadKey: str(raw.threadId) || null,
        from: addressOf(str(raw.from)),
        fromLabel: displayName(str(raw.from)),
        to: addrList(detail?.to ?? raw.to),
        at,
        // A Sent mailbox row says so itself; the From header never does.
        fromOwner:
          raw.sent === true || str(raw.mailboxRole) === "sent" || /^sent/i.test(str(raw.mailbox)),
        text: detail === undefined ? bodyOf(raw) : bodyOf(detail) || bodyOf(raw),
      });
    }
  }
  const seen = new Set<string>();
  const items: LaneItem[] = [];
  for (const m of raws.sort((a, b) => a.at - b.at)) {
    if (m.id === "" || seen.has(m.id)) continue;
    seen.add(m.id);
    const item = toItem(m, deps);
    if (item !== undefined) items.push(item);
  }
  return items;
}
