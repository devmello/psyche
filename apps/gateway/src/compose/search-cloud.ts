import type { ConnectorRecord } from "@psyche/connectors";
import type { ToolCall } from "@psyche/search";

/**
 * Apple-shaped tool calls over the cloud connectors, for the Search sources, Memory → Work and
 * search reads on a host without the Apple apps (Windows without classic Outlook): `mail_search`
 * / `mail_read` over Outlook (Microsoft 365, `mail_search_messages`) and Gmail
 * (`gmail_search_threads`), `calendar_list_events` over Outlook and Google Calendar, and
 * `reminders_list` / `reminders_list_lists` merged over every Reminders backend (Apple Reminders
 * or the Windows helper's Outlook tasks, and Microsoft To Do).
 *
 * Nothing here changes what a row is: each comes from the connector's own tool, through the
 * owner's action matrix, and the search adapters keep deciding provenance (other people's mail is
 * untrusted; an event or a reminder is the owner's only when the #1006 check says so).
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
const rows = (out: unknown, ...keys: string[]): Obj[] => {
  const raw = Array.isArray(out)
    ? out
    : isObj(out)
      ? keys.map((k) => out[k]).find(Array.isArray)
      : undefined;
  return (Array.isArray(raw) ? raw : []).filter(isObj);
};
const ms = (v: unknown): number | undefined => {
  const s = str(v);
  if (s === undefined) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
};

/** One connector tool, run as the Gateway's search reader runs it. */
export type Exec = (
  rec: ConnectorRecord,
  tool: string,
  params: Obj,
  signal: AbortSignal,
) => Promise<unknown>;

/** `<connectorId>|<native id>`: which connection a row came from, so a read goes back to it. */
const SEP = "|";
const tag = (rec: ConnectorRecord, id: string) => `${rec.id}${SEP}${id}`;
function untag(
  backends: readonly ConnectorRecord[],
  id: unknown,
): { rec: ConnectorRecord; id: string } {
  const s = typeof id === "string" ? id : "";
  const at = s.indexOf(SEP);
  const rec = at > 0 ? backends.find((r) => r.id === s.slice(0, at)) : undefined;
  if (rec === undefined) throw new Error("that item is not from a connected account");
  return { rec, id: s.slice(at + 1) };
}

const DAY = 86_400_000;
/** Pages one backend may read for one search: enough for a 500-row id sweep. */
const MAX_PAGES = 12;
/** The connectors' page sizes. */
const OUTLOOK_PAGE = 50;
const GMAIL_PAGE = 50;
const CAL_PAGE = 250;
/** A full calendar page is split in halves, at most this many times. */
const CAL_MAX_DEPTH = 6;
const CAL_MAX_SPAN = 366 * DAY;

// --- mail ------------------------------------------------------------------------------------

/**
 * `mail_search { since, until, limit }`: the newest `limit` messages in [since, until) over every
 * mail backend, newest first. Outlook's search takes days, so its range is widened by a day each
 * way and cut back here; its inbox and Sent are both read. Gmail is by thread.
 */
export function cloudMailCall(backends: readonly ConnectorRecord[], exec: Exec): ToolCall {
  const outlook = async (rec: ConnectorRecord, p: Obj, signal: AbortSignal): Promise<Obj[]> => {
    const since = ms(p.since);
    const until = ms(p.until) ?? Date.now();
    const limit = typeof p.limit === "number" ? p.limit : 25;
    const out: Obj[] = [];
    for (const mailbox of [undefined, "sent"]) {
      let pageToken: string | undefined;
      let inRange = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        let got: unknown;
        try {
          got = await exec(
            rec,
            "mail_search_messages",
            {
              maxResults: OUTLOOK_PAGE,
              ...(mailbox === undefined ? {} : { mailbox }),
              ...(pageToken !== undefined
                ? { pageToken }
                : {
                    ...(since === undefined ? {} : { since: new Date(since - DAY).toISOString() }),
                    before: new Date(until + DAY).toISOString(),
                  }),
            },
            signal,
          );
        } catch (err) {
          // An account without a Sent folder by that role: its inbox still counts.
          if (mailbox === "sent") break;
          throw err;
        }
        for (const m of rows(got, "messages")) {
          const at = ms(m.date);
          const id = str(m.id);
          if (id === undefined || at === undefined || at >= until) continue;
          if (since !== undefined && at < since) continue;
          inRange += 1;
          out.push({
            id: tag(rec, id),
            date: new Date(at).toISOString(),
            subject: str(m.subject) ?? "",
            from: str(m.from) ?? "",
            to: str(m.to) ?? "",
            ...(str(m.threadId) === undefined ? {} : { threadId: str(m.threadId) }),
            mailbox: mailbox === "sent" ? "Sent" : "Inbox",
            ...(mailbox === "sent" ? { sent: true } : {}),
            ...(rec.account === null ? {} : { account: rec.account }),
            snippet: str(m.snippet) ?? "",
          });
        }
        const next = isObj(got) ? str(got.nextPageToken) : undefined;
        if (next === undefined || inRange >= limit) break;
        pageToken = next;
      }
    }
    return out;
  };
  const gmail = async (rec: ConnectorRecord, p: Obj, signal: AbortSignal): Promise<Obj[]> => {
    const since = ms(p.since);
    const until = ms(p.until) ?? Date.now();
    const limit = typeof p.limit === "number" ? p.limit : 25;
    const q = [
      since === undefined ? "" : `after:${Math.floor(since / 1000)}`,
      `before:${Math.ceil(until / 1000)}`,
    ]
      .filter((x) => x !== "")
      .join(" ");
    const out: Obj[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES && out.length < limit; page++) {
      const got = await exec(
        rec,
        "gmail_search_threads",
        {
          query: q,
          maxResults: Math.min(GMAIL_PAGE, limit),
          ...(pageToken === undefined ? {} : { pageToken }),
        },
        signal,
      );
      for (const t of rows(got, "threads")) {
        const id = str(t.id);
        const at = ms(t.date);
        // A thread is dated by its newest message: one newer than this window is read in the
        // window that holds that message.
        if (id === undefined || at === undefined || at >= until) continue;
        if (since !== undefined && at < since) continue;
        out.push({
          id: tag(rec, `t:${id}`),
          date: new Date(at).toISOString(),
          subject: str(t.subject) ?? "",
          from: str(t.from) ?? "",
          threadId: id,
          mailbox: Array.isArray(t.labelIds) && t.labelIds.includes("SENT") ? "Sent" : "Inbox",
          ...(rec.account === null ? {} : { account: rec.account }),
          snippet: str(t.snippet) ?? "",
        });
      }
      const next = isObj(got) ? str(got.nextPageToken) : undefined;
      if (next === undefined) break;
      pageToken = next;
    }
    return out;
  };
  const read = async (p: Obj, signal: AbortSignal): Promise<unknown> => {
    const { rec, id } = untag(backends, p.id);
    if (rec.type === "google") {
      const t = await exec(rec, "gmail_read_thread", { threadId: id.replace(/^t:/, "") }, signal);
      const msgs = rows(t, "messages");
      const first = msgs[0] ?? {};
      return {
        from: str(first.from) ?? "",
        to: str(first.to) ?? "",
        cc: str(first.cc) ?? "",
        subject: str(first.subject) ?? "",
        body: msgs
          .map((m) => [`From: ${str(m.from) ?? ""}`, str(m.body) ?? ""].join("\n"))
          .join("\n\n"),
      };
    }
    const m = await exec(rec, "mail_read_message", { id }, signal);
    return isObj(m)
      ? { from: m.from, to: m.to, cc: m.cc, subject: m.subject, body: m.body }
      : undefined;
  };
  return async (tool, p, signal) => {
    if (tool === "mail_read") return read(p, signal);
    if (tool !== "mail_search") throw new Error(`${tool} is not available`);
    const limit = typeof p.limit === "number" ? p.limit : 25;
    const all: Obj[] = [];
    for (const rec of backends)
      all.push(...(await (rec.type === "google" ? gmail : outlook)(rec, p, signal)));
    all.sort((a, b) => (ms(b.date) ?? 0) - (ms(a.date) ?? 0));
    return { messages: all.slice(0, limit) };
  };
}

// --- calendar --------------------------------------------------------------------------------

/** A Google-shaped event time (`{ dateTime }` or `{ date }`) as ISO, and whether it is all day. */
function when(t: unknown): { iso?: string; allDay: boolean } {
  if (!isObj(t)) return { allDay: false };
  const dt = str(t.dateTime);
  if (dt !== undefined) return { iso: dt, allDay: false };
  const d = str(t.date);
  return d === undefined ? { allDay: true } : { iso: `${d}T00:00:00Z`, allDay: true };
}

/**
 * `calendar_list_events { from, to, limit }` over Outlook and Google Calendar (their primary
 * calendars), in the Calendar app's shape. A page that comes back full is split in halves and read
 * again, so a busy range is read whole.
 */
export function cloudCalendarCall(backends: readonly ConnectorRecord[], exec: Exec): ToolCall {
  const read = async (
    rec: ConnectorRecord,
    a: number,
    b: number,
    signal: AbortSignal,
    depth: number,
  ): Promise<Obj[]> => {
    if (b - a > CAL_MAX_SPAN) {
      const mid = a + CAL_MAX_SPAN;
      return [
        ...(await read(rec, a, mid, signal, depth)),
        ...(await read(rec, mid, b, signal, depth)),
      ];
    }
    const got = rows(
      await exec(
        rec,
        "calendar_list_events",
        {
          timeMin: new Date(a).toISOString(),
          timeMax: new Date(b).toISOString(),
          maxResults: CAL_PAGE,
        },
        signal,
      ),
      "events",
    );
    if (got.length < CAL_PAGE || depth >= CAL_MAX_DEPTH || b - a <= 3_600_000) return got;
    const mid = Math.floor((a + b) / 2);
    return [
      ...(await read(rec, a, mid, signal, depth + 1)),
      ...(await read(rec, mid, b, signal, depth + 1)),
    ];
  };
  return async (tool, p, signal) => {
    if (tool !== "calendar_list_events") throw new Error(`${tool} is not available`);
    const from = ms(p.from);
    const to = ms(p.to);
    if (from === undefined || to === undefined || to <= from) return { events: [] };
    const limit = typeof p.limit === "number" ? p.limit : 500;
    const seen = new Set<string>();
    const events: Obj[] = [];
    for (const rec of backends) {
      for (const e of await read(rec, from, to, signal, 0)) {
        const id = str(e.id);
        const start = when(e.start);
        if (id === undefined || start.iso === undefined || e.status === "cancelled") continue;
        const key = `${rec.id}\u0000${id}\u0000${start.iso}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const attendees = rows(e.attendees).flatMap((x) =>
          str(x.email) === undefined ? [] : [{ email: str(x.email) as string }],
        );
        events.push({
          id: tag(rec, id),
          calendarId: tag(rec, "primary"),
          calendar: rec.label,
          title: str(e.summary) ?? "(no title)",
          start: start.iso,
          ...(when(e.end).iso === undefined ? {} : { end: when(e.end).iso }),
          allDay: start.allDay,
          ...(str(e.location) === undefined ? {} : { location: str(e.location) }),
          ...(str(e.description) === undefined ? {} : { notes: str(e.description) }),
          ...(str(e.htmlLink) === undefined ? {} : { url: str(e.htmlLink) }),
          ...(str(e.organizer) === undefined ? {} : { organizer: { email: str(e.organizer) } }),
          ...(attendees.length === 0 ? {} : { attendees }),
        });
      }
    }
    events.sort((a, b) => (ms(a.start) ?? 0) - (ms(b.start) ?? 0));
    return { events: events.slice(0, limit) };
  };
}

// --- reminders -------------------------------------------------------------------------------

/** The day a reminder is due, for telling one task synced into two backends from two tasks. */
const dueDay = (r: Obj) => str(r.due)?.slice(0, 10) ?? "";
const sameTask = (r: Obj) =>
  `${(str(r.title) ?? "").toLowerCase()}\u0000${dueDay(r)}\u0000${r.completed === true}`;

/**
 * `reminders_list` / `reminders_list_lists` over several Reminders backends at once (the Apple
 * Reminders or Windows Outlook connector first, then Microsoft To Do). Each backend is read whole
 * and the merged list is sorted and paged here, so `offset` means the same as on one backend. An
 * Outlook task that also syncs to To Do (one Microsoft account) shows once: the first backend's
 * row wins when the title, due day and state are the same.
 */
export function mergedRemindersCall(backends: readonly ConnectorRecord[], exec: Exec): ToolCall {
  const PAGE = 500;
  const whole = async (rec: ConnectorRecord, p: Obj, signal: AbortSignal): Promise<Obj[]> => {
    const out: Obj[] = [];
    const filter: Obj = { ...p };
    delete filter.offset;
    delete filter.limit;
    for (let page = 0; page < 40; page++) {
      const got = rows(
        await exec(
          rec,
          "reminders_list",
          { ...filter, limit: PAGE, ...(page === 0 ? {} : { offset: page * PAGE }) },
          signal,
        ),
        "reminders",
      );
      out.push(...got);
      if (got.length < PAGE) break;
    }
    return out;
  };
  return async (tool, p, signal) => {
    if (tool === "reminders_list_lists") {
      const lists: Obj[] = [];
      for (const rec of backends)
        lists.push(...rows(await exec(rec, "reminders_list_lists", {}, signal), "lists"));
      return { lists };
    }
    if (tool !== "reminders_list") throw new Error(`${tool} is not available`);
    const seen = new Set<string>();
    const all: Obj[] = [];
    for (const rec of backends) {
      for (const r of await whole(rec, p, signal)) {
        const k = sameTask(r);
        if (seen.has(k)) continue;
        seen.add(k);
        all.push(r);
      }
    }
    const due = (r: Obj) => ms(r.due) ?? Number.POSITIVE_INFINITY;
    all.sort((a, b) => due(a) - due(b));
    const offset = typeof p.offset === "number" ? p.offset : 0;
    const limit = typeof p.limit === "number" ? p.limit : 50;
    return { reminders: all.slice(offset, offset + limit) };
  };
}
