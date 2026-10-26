import { type ConnectorRecord, toolName } from "@psyche/connectors";
import type {
  Address,
  ContactRecord,
  EventRecord,
  GraphPull,
  GraphSourceAdapter,
  MailRecord,
} from "@psyche/memory";
import type { Clock, ToolRegistry } from "@psyche/protocol";

/**
 * Ingest adapters for the people graph (docs/memory/people-and-projects-2026.md §5.1): each
 * connected app's read tools, mapped to connector-neutral ingest records. The tools are the same
 * ones the agent calls (`mcp__<connector id>__<tool>`), so the owner's action matrix applies: a
 * read set to `deny` stops ingest from that app too. Everything they return is third-party data;
 * ingest stores headers and addresses only, never bodies.
 */

const DAY_MS = 86_400_000;
/** First pass looks back this far; later passes re-read a short window (events move). */
const CALENDAR_BACKFILL_DAYS = 90;
const CALENDAR_RECENT_DAYS = 2;
const CALENDAR_AHEAD_DAYS = 14;
/** Contacts are re-read at most daily: the helper has no change feed. */
const CONTACTS_REFRESH_MS = DAY_MS;
const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

export interface SourceDeps {
  connectors: () => Promise<ConnectorRecord[]>;
  tools: Pick<ToolRegistry, "get">;
  clock: Clock;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
const strs = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.flatMap((x) => (typeof x === "string" && x.trim() !== "" ? [x.trim()] : []))
    : [];
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

async function call(
  deps: SourceDeps,
  record: ConnectorRecord,
  tool: string,
  params: Obj,
  signal: AbortSignal,
): Promise<unknown> {
  const reg = deps.tools.get(toolName(record.id, tool));
  if (reg === undefined) throw new Error(`${tool} is not available on ${record.id}`);
  const res = await reg.execute(
    `graph:${record.id}:${tool}:${deps.clock.now()}`,
    params,
    signal,
    () => {},
  );
  if (res.isError === true) throw new Error(`${tool} failed on ${record.id}`);
  return res.output;
}

/** The account address a mail or calendar connection signed in with, when it is one. */
function accountIdentities(record: ConnectorRecord) {
  return async () => {
    const account = str(record.account);
    return account !== undefined && EMAIL.test(account) ? { emails: [account] } : {};
  };
}

// --- contacts --------------------------------------------------------------------------------

/** Apple Contacts and Outlook contacts: no list call, so every letter is searched and deduped. */
function contactsAdapter(deps: SourceDeps, record: ConnectorRecord): GraphSourceAdapter {
  const apple = record.type === "apple:contacts";
  return {
    id: `contacts:${record.id}`,
    source: "contacts",
    async pull(cursor, signal): Promise<GraphPull> {
      const last = isObj(cursor) && typeof cursor.at === "string" ? Date.parse(cursor.at) : 0;
      const now = deps.clock.now();
      if (now - last < CONTACTS_REFRESH_MS) return { cursor };
      const byId = new Map<string, ContactRecord>();
      for (const letter of LETTERS) {
        if (signal.aborted) break;
        const out = await call(
          deps,
          record,
          "contacts_search",
          apple ? { query: letter, limit: 500 } : { query: letter, maxResults: 100 },
          signal,
        );
        const list = apple ? (isObj(out) ? out.contacts : undefined) : out;
        for (const c of Array.isArray(list) ? list : []) {
          if (!isObj(c)) continue;
          const id = str(c.id);
          const name = str(c.name);
          if (id === undefined || name === undefined || byId.has(id)) continue;
          const organization = str(apple ? c.organization : c.company);
          byId.set(id, {
            id: apple ? id : `${record.id}:${id}`,
            name,
            emails: strs(c.emails),
            phones: strs(c.phones),
            ...(organization === undefined ? {} : { organization }),
          });
        }
      }
      return { contacts: [...byId.values()], cursor: { at: new Date(now).toISOString() } };
    },
  };
}

// --- calendar --------------------------------------------------------------------------------

function calendarWindow(cursor: unknown, now: number) {
  const back =
    cursor === null || cursor === undefined ? CALENDAR_BACKFILL_DAYS : CALENDAR_RECENT_DAYS;
  return {
    from: new Date(now - back * DAY_MS).toISOString(),
    to: new Date(now + CALENDAR_AHEAD_DAYS * DAY_MS).toISOString(),
  };
}

/** Apple Calendar: attendees carry names and an organizer flag. */
export function appleEvents(output: unknown, source: string): EventRecord[] {
  const events = isObj(output) ? output.events : undefined;
  const out: EventRecord[] = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!isObj(e)) continue;
    const id = str(e.id);
    const start = str(e.start);
    if (id === undefined || start === undefined) continue;
    const people = (Array.isArray(e.attendees) ? e.attendees : []).flatMap((a) => {
      if (!isObj(a)) return [];
      const email = str(a.email);
      if (email === undefined) return [];
      const name = str(a.name);
      return [{ email, ...(name === undefined ? {} : { name }), organizer: a.organizer === true }];
    });
    const organizer = people.find((p) => p.organizer);
    const title = str(e.title);
    const link = str(e.url);
    out.push({
      source,
      id,
      start,
      ...(title === undefined ? {} : { title }),
      ...(organizer === undefined
        ? {}
        : {
            organizer: {
              email: organizer.email,
              ...(organizer.name === undefined ? {} : { name: organizer.name }),
            },
          }),
      attendees: people
        .filter((p) => !p.organizer)
        .map((p) => ({ email: p.email, ...(p.name === undefined ? {} : { name: p.name }) })),
      ...(link === undefined ? {} : { link }),
    });
  }
  return out;
}

/** Google and Microsoft `EventView`s (Google returns a bare array, Microsoft `{events}`). */
export function cloudEvents(output: unknown, source: string): EventRecord[] {
  const events = Array.isArray(output) ? output : isObj(output) ? output.events : undefined;
  const out: EventRecord[] = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!isObj(e)) continue;
    const id = str(e.id);
    const start = isObj(e.start) ? (str(e.start.dateTime) ?? str(e.start.date)) : str(e.start);
    if (id === undefined || start === undefined) continue;
    const organizer = str(e.organizer);
    const title = str(e.summary);
    const link = str(e.htmlLink);
    const attendees = (Array.isArray(e.attendees) ? e.attendees : []).flatMap((a) => {
      const email = isObj(a) ? str(a.email) : undefined;
      return email === undefined || email === organizer ? [] : [{ email }];
    });
    out.push({
      source,
      id,
      start: start.length === 10 ? `${start}T00:00:00.000Z` : start,
      ...(title === undefined ? {} : { title }),
      ...(organizer === undefined ? {} : { organizer: { email: organizer } }),
      attendees,
      ...(link === undefined ? {} : { link }),
      ...(e.status === "cancelled" ? { deleted: true } : {}),
    });
  }
  return out;
}

function calendarAdapter(deps: SourceDeps, record: ConnectorRecord): GraphSourceAdapter {
  const apple = record.type === "apple:calendar";
  const source = apple ? "apple:calendar" : `${record.type}:calendar`;
  return {
    id: `calendar:${record.id}`,
    source: "calendar",
    ownerIdentities: accountIdentities(record),
    async pull(cursor, signal): Promise<GraphPull> {
      const now = deps.clock.now();
      const { from, to } = calendarWindow(cursor, now);
      const output = await call(
        deps,
        record,
        "calendar_list_events",
        apple ? { from, to, limit: 500 } : { timeMin: from, timeMax: to, maxResults: 250 },
        signal,
      );
      return {
        events: apple ? appleEvents(output, source) : cloudEvents(output, source),
        cursor: { at: new Date(now).toISOString() },
      };
    },
  };
}

// --- mail ------------------------------------------------------------------------------------

/** First pass looks back this far; later passes continue from the newest message seen. */
const MAIL_BACKFILL_DAYS = 30;
/** Full reads (recipients) per pass: sent mail only on Apple Mail, threads on Gmail. */
const MAIL_READS_PER_PASS = 50;
const MAIL_PAGES_PER_PASS = 5;
/** First lines of the owner's own sent mail, for the no-reply rule (transient, never stored). */
const OWNER_SNIPPET_CHARS = 500;

/**
 * `Name <a@b.c>, "Last, First" <d@e.f>, g@h.i` → addresses. Display names are third-party
 * text: they are only ever used as a new person's first name, never to merge.
 */
export function parseAddresses(header: unknown): Address[] {
  const text = typeof header === "string" ? header : Array.isArray(header) ? header.join(", ") : "";
  const out: Address[] = [];
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === "<") angle = true;
    if (ch === ">") angle = false;
    if (ch === "," && !quoted && !angle) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  for (const part of parts) {
    const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/.exec(part);
    const email = m?.[2] ?? part.trim();
    if (!EMAIL.test(email)) continue;
    const name = m?.[1]?.trim();
    out.push({ email, ...(name === undefined || name === "" ? {} : { name }) });
  }
  return out;
}

const iso = (date: unknown): string | undefined => {
  const t = typeof date === "string" ? Date.parse(date) : Number.NaN;
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};

/** `message://%3Cid%40host%3E` → `id@host` (Apple Mail links carry the Message-ID). */
function messageIdFromLink(link: string | undefined): string | undefined {
  const m = link === undefined ? null : /^message:\/\/(.+)$/.exec(link);
  if (m === null || m[1] === undefined) return undefined;
  try {
    return decodeURIComponent(m[1]).replace(/^<|>$/g, "");
  } catch {
    return undefined;
  }
}

/**
 * Apple Mail: summaries have the sender only, so a received message records the people already
 * known; the owner's sent mail is read for its recipients (that is how new people are met).
 */
function appleMailAdapter(deps: SourceDeps, record: ConnectorRecord): GraphSourceAdapter {
  return {
    id: `mail:${record.id}`,
    source: "mail",
    async pull(cursor, signal): Promise<GraphPull> {
      const since = readMailCursor(cursor, deps.clock.now()).since;
      const out = await call(deps, record, "mail_search", { since, limit: 500 }, signal);
      const list = isObj(out) && Array.isArray(out.messages) ? out.messages : [];
      const mails: MailRecord[] = [];
      let reads = 0;
      for (const m of list) {
        if (!isObj(m) || signal.aborted) continue;
        const id = str(m.id);
        const date = iso(m.date);
        const [from] = parseAddresses(m.from);
        if (id === undefined || date === undefined || from === undefined) continue;
        const link = str(m.link);
        const subject = str(m.subject);
        const mail: MailRecord = {
          source: "apple:mail",
          messageId: messageIdFromLink(link) ?? id,
          date,
          from,
          ...(subject === undefined ? {} : { subject }),
          ...(link === undefined ? {} : { link }),
        };
        const sent = /sent/i.test(str(m.mailbox) ?? "");
        if (sent && reads < MAIL_READS_PER_PASS) {
          reads++;
          const read = await call(
            deps,
            record,
            "mail_read",
            {
              id,
              ...(str(m.mailbox) === undefined ? {} : { mailbox: str(m.mailbox) }),
              ...(str(m.account) === undefined ? {} : { account: str(m.account) }),
              maxLength: 2000,
            },
            signal,
          ).catch(() => undefined);
          const msg = isObj(read) && isObj(read.message) ? read.message : undefined;
          if (msg !== undefined) {
            mail.to = parseAddresses(msg.to);
            mail.cc = parseAddresses(msg.cc);
            const body = str(msg.body);
            if (body !== undefined) mail.ownerSnippet = body.slice(0, OWNER_SNIPPET_CHARS);
          }
        }
        mails.push(mail);
      }
      return { mails, cursor: nextMailCursor({ since }, mails, {}) };
    },
  };
}

/**
 * Mail cursor: `since` is where the pass reads from. When a pass runs out of its page budget
 * with pages left, `resume` keeps each folder's next page and `high` the newest message seen, so
 * the next pass finishes the backlog before moving `since` forward; nothing is skipped.
 */
interface MailCursor {
  since: string;
  high?: string;
  resume?: Record<string, string>;
}

function readMailCursor(cursor: unknown, now: number): MailCursor {
  const since =
    isObj(cursor) && typeof cursor.since === "string"
      ? cursor.since
      : new Date(now - MAIL_BACKFILL_DAYS * DAY_MS).toISOString();
  const high = isObj(cursor) ? str(cursor.high) : undefined;
  const resume =
    isObj(cursor) && isObj(cursor.resume)
      ? Object.fromEntries(
          Object.entries(cursor.resume).flatMap(([k, v]) =>
            typeof v === "string" ? [[k, v]] : [],
          ),
        )
      : undefined;
  return {
    since,
    ...(high === undefined ? {} : { high }),
    ...(resume === undefined ? {} : { resume }),
  };
}

function nextMailCursor(
  current: MailCursor,
  mails: MailRecord[],
  resume: Record<string, string>,
): MailCursor {
  const high = mails.reduce(
    (max, r) => (r.date > max ? r.date : max),
    current.high ?? current.since,
  );
  return Object.keys(resume).length > 0 ? { since: current.since, high, resume } : { since: high };
}

/** Gmail: thread search has no recipients, so each new thread is read for its headers. */
function gmailAdapter(deps: SourceDeps, record: ConnectorRecord): GraphSourceAdapter {
  return {
    id: `mail:${record.id}`,
    source: "mail",
    ownerIdentities: accountIdentities(record),
    async pull(raw, signal): Promise<GraphPull> {
      const cursor = readMailCursor(raw, deps.clock.now());
      const after = Math.floor(Date.parse(cursor.since) / 1000);
      const mails: MailRecord[] = [];
      const account = str(record.account)?.toLowerCase();
      let pageToken = cursor.resume?.all;
      let reads = 0;
      let more = false;
      for (let page = 0; page < MAIL_PAGES_PER_PASS; page++) {
        if (reads >= MAIL_READS_PER_PASS || signal.aborted) {
          more = true;
          break;
        }
        const out = await call(
          deps,
          record,
          "gmail_search_threads",
          {
            query: `after:${after}`,
            maxResults: MAIL_READS_PER_PASS,
            ...(pageToken === undefined ? {} : { pageToken }),
          },
          signal,
        );
        const threads = isObj(out) && Array.isArray(out.threads) ? out.threads : [];
        for (const t of threads) {
          if (!isObj(t)) continue;
          const threadId = str(t.id);
          if (threadId === undefined) continue;
          reads++;
          const read = await call(deps, record, "gmail_read_thread", { threadId }, signal).catch(
            () => undefined,
          );
          const messages = isObj(read) && Array.isArray(read.messages) ? read.messages : [];
          for (const m of messages) {
            if (!isObj(m)) continue;
            const date = iso(m.date);
            const [from] = parseAddresses(m.from);
            if (date === undefined || from === undefined || date < cursor.since) continue;
            const subject = str(m.subject);
            const own = account !== undefined && from.email.toLowerCase() === account;
            const body = own ? str(m.body) : undefined;
            mails.push({
              source: "google:mail",
              messageId: str(m.messageId)?.replace(/^<|>$/g, "") ?? str(m.id) ?? threadId,
              date,
              from,
              to: parseAddresses(m.to),
              cc: parseAddresses(m.cc),
              threadKey: threadId,
              link: `https://mail.google.com/mail/#all/${encodeURIComponent(threadId)}`,
              ...(subject === undefined ? {} : { subject }),
              ...(body === undefined ? {} : { ownerSnippet: body.slice(0, OWNER_SNIPPET_CHARS) }),
            });
          }
        }
        pageToken = isObj(out) ? str(out.nextPageToken) : undefined;
        if (pageToken === undefined) break;
        if (page === MAIL_PAGES_PER_PASS - 1) more = true;
      }
      const resume: Record<string, string> =
        more && pageToken !== undefined ? { all: pageToken } : {};
      return { mails, cursor: nextMailCursor(cursor, mails, resume) };
    },
  };
}

/** IMAP, JMAP and Outlook (`mail_search_messages`): sender and recipients in the summary. */
function mailboxAdapter(deps: SourceDeps, record: ConnectorRecord): GraphSourceAdapter {
  const source = `${record.type}:mail`;
  return {
    id: `mail:${record.id}`,
    source: "mail",
    ownerIdentities: accountIdentities(record),
    async pull(raw, signal): Promise<GraphPull> {
      const cursor = readMailCursor(raw, deps.clock.now());
      const mails: MailRecord[] = [];
      const seen = new Set<string>();
      const resume: Record<string, string> = {};
      // The inbox (default) and the sent folder, where the owner's own mail is.
      for (const mailbox of ["", "Sent"]) {
        let pageToken = cursor.resume?.[mailbox];
        for (let page = 0; page < MAIL_PAGES_PER_PASS; page++) {
          const out = await call(
            deps,
            record,
            "mail_search_messages",
            {
              since: cursor.since.slice(0, 10),
              maxResults: 50,
              ...(mailbox === "" ? {} : { mailbox }),
              ...(pageToken === undefined ? {} : { pageToken }),
            },
            signal,
          ).catch((err: unknown) => {
            // Not every server has a folder named Sent.
            if (mailbox !== "") return undefined;
            throw err;
          });
          const list = isObj(out) && Array.isArray(out.messages) ? out.messages : [];
          for (const m of list) {
            if (!isObj(m)) continue;
            const id = str(m.id);
            const date = iso(m.date);
            const [from] = parseAddresses(m.from);
            if (id === undefined || date === undefined || from === undefined) continue;
            if (date < cursor.since || seen.has(id)) continue;
            seen.add(id);
            const subject = str(m.subject);
            const threadKey = str(m.threadId);
            mails.push({
              source,
              messageId: id,
              date,
              from,
              to: parseAddresses(m.to),
              ...(subject === undefined ? {} : { subject }),
              ...(threadKey === undefined ? {} : { threadKey }),
            });
          }
          pageToken = isObj(out) ? str(out.nextPageToken) : undefined;
          if (pageToken === undefined) break;
        }
        if (pageToken !== undefined) resume[mailbox] = pageToken;
      }
      return { mails, cursor: nextMailCursor(cursor, mails, resume) };
    },
  };
}

function mailAdapter(deps: SourceDeps, record: ConnectorRecord): GraphSourceAdapter | undefined {
  if (record.type === "apple:mail") return appleMailAdapter(deps, record);
  if (record.type === "google") return gmailAdapter(deps, record);
  if (record.type === "imap" || record.type === "jmap" || record.type === "microsoft")
    return mailboxAdapter(deps, record);
  return undefined;
}

/** The adapters for every connected app that can feed the graph. */
export async function graphSourceAdapters(deps: SourceDeps): Promise<GraphSourceAdapter[]> {
  const adapters: GraphSourceAdapter[] = [];
  for (const record of await deps.connectors()) {
    if (record.status !== "connected") continue;
    if (record.type === "apple:contacts" || record.type === "microsoft")
      adapters.push(contactsAdapter(deps, record));
    if (record.type === "apple:calendar" || record.type === "google" || record.type === "microsoft")
      adapters.push(calendarAdapter(deps, record));
    const mail = mailAdapter(deps, record);
    if (mail !== undefined) adapters.push(mail);
  }
  return adapters;
}
