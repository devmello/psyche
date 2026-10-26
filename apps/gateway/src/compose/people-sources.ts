import { type ConnectorRecord, toolName } from "@psyche/connectors";
import type { ContactRecord, EventRecord, GraphPull, GraphSourceAdapter } from "@psyche/memory";
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

/** The adapters for every connected app that can feed the graph. */
export async function graphSourceAdapters(deps: SourceDeps): Promise<GraphSourceAdapter[]> {
  const adapters: GraphSourceAdapter[] = [];
  for (const record of await deps.connectors()) {
    if (record.status !== "connected") continue;
    if (record.type === "apple:contacts" || record.type === "microsoft")
      adapters.push(contactsAdapter(deps, record));
    if (record.type === "apple:calendar" || record.type === "google" || record.type === "microsoft")
      adapters.push(calendarAdapter(deps, record));
  }
  return adapters;
}
