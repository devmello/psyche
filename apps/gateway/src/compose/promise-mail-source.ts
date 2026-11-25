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
 * failed read yields nothing for that connector. A read that stopped at its cap says where the
 * next one may start (`nextSince`), so the scan's cursor never moves past mail that was not read.
 */

export interface MailSourceDeps {
  tools: () => ToolLookup | undefined;
  connectors: () => readonly ConnectorRef[] | Promise<readonly ConnectorRef[]>;
  /** An address to the person's entity id, or null for nobody the owner knows. */
  resolve: (address: string) => string | null;
  /** Whether the owner is in two-way touch with this person. */
  isTwoWay: (entityId: string) => boolean;
  logger?: { log(level: "warn", msg: string, fields?: Record<string, unknown>): void };
}

const MAX_MESSAGES = 30;
const SEARCH_PAGE = 100;
const MAX_THREADS = 15;
const MAX_RECIPIENTS = 8;
const MAX_HALVINGS = 6;
const epoch = (t: number): number => Math.floor(t / 1000);

// --- forwarded and quoted text ------------------------------------------------------------------

const FORWARD_MARKERS: readonly RegExp[] = [
  /^\s*-{3,}\s*forwarded message\s*-{3,}\s*$/i,
  /^\s*begin forwarded message:?\s*$/i,
  /^\s*-{2,}\s*original message\s*-{2,}\s*$/i,
];
const HEADER_LINE = /^\s*(from|sent|date|to|cc|subject)\s*:/i;

/**
 * What the sender wrote above any forward or reply marker. A forwarded message is somebody else's
 * words, and a quoted reply that is not `>`-quoted is too: everything from the first marker to the
 * end goes (design 3.1). A top-posted reply, with `>`-quoted history under it, is left to
 * `ownWords`, which drops the quoted lines.
 */
export function ownerMailText(text: string): string {
  const lines = text.split(/\r?\n/);
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (FORWARD_MARKERS.some((m) => m.test(line))) {
      end = i;
      break;
    }
    // An Outlook block: From: with Sent/Date and To/Subject close behind it.
    if (/^\s*from\s*:/i.test(line)) {
      const near = lines.slice(i + 1, i + 5).filter((l) => HEADER_LINE.test(l));
      const keys = new Set(near.map((l) => (/^\s*(\w+)/.exec(l)?.[1] ?? "").toLowerCase()));
      if ((keys.has("sent") || keys.has("date")) && (keys.has("to") || keys.has("subject"))) {
        end = i;
        break;
      }
    }
    // "On <date>, X wrote:" (possibly wrapped onto the next line), then unquoted text.
    const wraps = /^\s*wrote:\s*$/i.test(lines[i + 1] ?? "") && /^\s*on\s/i.test(line);
    if (/^\s*on\s.{5,300}\swrote:\s*$/i.test(line) || wraps) {
      const after = lines.slice(i + (wraps ? 2 : 1)).find((l) => l.trim() !== "");
      if (after !== undefined && !/^\s*>/.test(after)) {
        end = i;
        break;
      }
    }
  }
  return lines.slice(0, end).join("\n");
}

// --- raw messages -----------------------------------------------------------------------------

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
}

function toItem(m: RawMail, deps: MailSourceDeps): LaneItem | undefined {
  if (m.text.trim() === "" || isAutomatedSender(m.from)) return undefined;
  const people = new Set([m.from, ...m.to]);
  if (people.size > MAX_RECIPIENTS + 1) return undefined;
  const own = ownWords(ownerMailText(m.text));
  if (own.trim() === "") return undefined;
  if (m.fromOwner) {
    const known = m.to.map((a) => deps.resolve(a)).filter((x): x is string => x !== null);
    const only = known.length === 1 && m.to.length === 1 ? known[0] : undefined;
    return {
      source: "mail",
      sourceRef: `mail:${m.id}`,
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
    sourceRef: `mail:${m.id}`,
    threadId: m.threadKey,
    author: "counterpart",
    counterpartId: who,
    counterpartLabel: m.fromLabel.slice(0, 80),
    sentAt: new Date(m.at).toISOString(),
    text: own,
    groupSize: m.to.length + 1,
  };
}

// --- connectors ---------------------------------------------------------------------------------

/** How one family of boxed mail connectors lists Sent, searches and reads a message. */
interface BoxedFlavor {
  listBoxes: string;
  sentBoxes(list: unknown): Record<string, unknown>[];
  search: string;
  boxParams(box: Record<string, unknown>): Record<string, unknown>;
  limitKey: string;
  read: string;
  readParams(raw: Record<string, unknown>): Record<string, unknown>;
}
const APPLE_SENT = /^sent( (messages|mail|items))?$/i;
const APPLE: BoxedFlavor = {
  listBoxes: "mail_mailboxes",
  sentBoxes: (list) =>
    output<Record<string, unknown>>(list, "mailboxes").filter(
      (b) => b.special === "sent" || (b.special == null && APPLE_SENT.test(str(b.name).trim())),
    ),
  search: "mail_search",
  boxParams: (b) => ({
    mailbox: str(b.name),
    ...(str(b.account) === "" ? {} : { account: str(b.account) }),
  }),
  limitKey: "limit",
  read: "mail_read",
  readParams: (raw) => ({
    id: str(raw.id),
    maxLength: 4000,
    ...(str(raw.mailbox) === "" ? {} : { mailbox: str(raw.mailbox) }),
    ...(str(raw.account) === "" ? {} : { account: str(raw.account) }),
  }),
};
const IMAP: BoxedFlavor = {
  listBoxes: "mail_list_mailboxes",
  sentBoxes: (list) =>
    output<Record<string, unknown>>(list, "mailboxes").filter((b) => b.role === "sent"),
  search: "mail_search_messages",
  boxParams: (b) => ({ mailbox: str(b.id) }),
  limitKey: "maxResults",
  read: "mail_read_message",
  readParams: (raw) => ({
    id: str(raw.id),
    ...(str(raw.mailbox) === "" ? {} : { mailbox: str(raw.mailbox) }),
  }),
};

export interface MailBatch {
  items: LaneItem[];
  /** Where the next read may start when this one stopped at a cap; undefined: it read everything. */
  nextSince?: number;
}

/** Mail since `sinceMs`, as lane items. */
export async function readMailBatch(deps: MailSourceDeps, sinceMs: number): Promise<MailBatch> {
  const tools = deps.tools();
  if (tools === undefined) return { items: [] };
  const raws: RawMail[] = [];
  let resume: number | undefined;
  const clip = (t: number): void => {
    resume = resume === undefined ? t : Math.min(resume, t);
  };
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
      // Gmail takes epoch seconds: a calendar day would be the UTC day, and lose an evening's
      // mail for an owner west of UTC. A full page narrows the window (oldest half first) so
      // nothing in it is skipped; the cursor then moves only to the end of what was read.
      let until = Date.now();
      let threads: { id?: unknown }[] = [];
      for (let i = 0; i <= MAX_HALVINGS; i++) {
        const query = `after:${epoch(sinceMs)} before:${epoch(until) + 1}`;
        const found = await safe("gmail_search_threads", () =>
          readConnectorTool(tools, c.id, "gmail_search_threads", {
            query,
            maxResults: MAX_THREADS,
          }),
        );
        threads = output<{ id?: unknown }>(found, "threads");
        if (threads.length < MAX_THREADS || until - sinceMs < 2000) break;
        until = sinceMs + Math.floor((until - sinceMs) / 2);
      }
      if (until < Date.now() - 1000) clip(until);
      for (const t of threads.slice(0, MAX_THREADS)) {
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
            at > until ||
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
    // Apple Mail, IMAP, JMAP and Outlook: the owner's mail is what sits in the Sent mailbox, which
    // is searched by name; the inbox (the default) holds everyone else's.
    const f = c.type === "apple:mail" ? APPLE : IMAP;
    const boxes = await safe(f.listBoxes, () => readConnectorTool(tools, c.id, f.listBoxes, {}));
    const searches: { params: Record<string, unknown>; sentBox: boolean }[] = [
      ...f
        .sentBoxes(boxes)
        .slice(0, 3)
        .map((b) => ({ params: f.boxParams(b), sentBox: true })),
      { params: {}, sentBox: false },
    ];
    for (const { params, sentBox } of searches) {
      const found = await safe(f.search, () =>
        readConnectorTool(tools, c.id, f.search, { ...params, since, [f.limitKey]: SEARCH_PAGE }),
      );
      const rows = output<Record<string, unknown>>(found, "messages")
        .map((raw) => ({ raw, at: ms(raw.date), from: addressOf(str(raw.from)) }))
        .filter((r) => !Number.isNaN(r.at) && r.at > sinceMs)
        // Automated senders go before the cap, so they cannot crowd out real mail.
        .filter((r) => sentBox || !isAutomatedSender(r.from))
        .sort((a, b) => a.at - b.at);
      for (const r of rows.slice(0, MAX_MESSAGES)) {
        const full = await safe(f.read, () =>
          readConnectorTool(tools, c.id, f.read, f.readParams(r.raw)),
        );
        const wrapped = (full as Record<string, unknown> | undefined)?.message;
        const detail = (wrapped !== null && typeof wrapped === "object" ? wrapped : full) as
          | Record<string, unknown>
          | undefined;
        raws.push({
          id: str(r.raw.id),
          threadKey: str(r.raw.threadId) || null,
          from: r.from,
          fromLabel: displayName(str(r.raw.from)),
          to: addrList(detail?.to ?? r.raw.to),
          at: r.at,
          // Only a row out of the account's own Sent mailbox is the owner's.
          fromOwner: sentBox,
          text: detail === undefined ? bodyOf(r.raw) : bodyOf(detail) || bodyOf(r.raw),
        });
      }
      // Cut short: the next read starts at the last message this one read.
      if (rows.length > MAX_MESSAGES) clip((rows[MAX_MESSAGES - 1] as { at: number }).at);
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
  return { items, ...(resume === undefined ? {} : { nextSince: resume }) };
}

export async function readMailItems(deps: MailSourceDeps, sinceMs: number): Promise<LaneItem[]> {
  return (await readMailBatch(deps, sinceMs)).items;
}
