import { type ContactsSourceDeps, contactsAdapter } from "./contacts.ts";
import { addressOf } from "./exclusion.ts";
import { messageIdFromLink } from "./open.ts";
import { htmlToText, stripQuotedReplies } from "./text.ts";
import type { SourceAdapter, SourceItem, SourcePull } from "./types.ts";

/**
 * Adapters over the Apple connector's tools (Mail, Notes, Calendar, Reminders) and the Mac
 * helper's Messages read. They only parse: the Gateway hands in `call` and `helper`, so tests run
 * on fixtures and no real Mail, Messages or `chat.db` is ever read from here.
 *
 * Provenance: other people's mail and messages are `untrusted` (the highest prompt-injection
 * risk); the owner's own sent mail and messages are `owner`. Notes, events and reminders are
 * `owner` only when the #1006 trusted-sources check says so (`owned`), else `untrusted`.
 *
 * On Windows (`platform: "win32"`) the same adapters read whatever the Gateway hands in for an app
 * (the Windows helper's Outlook, else Microsoft 365, Google or To Do through `call`), and the
 * Mac-only sources, Notes and Messages, are not offered at all.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
const strs = (v: unknown): string[] =>
  typeof v === "string"
    ? v
        .split(/[,;]/)
        .map((x) => x.trim())
        .filter((x) => x !== "")
    : Array.isArray(v)
      ? v.flatMap((x) => (typeof x === "string" && x.trim() !== "" ? [x.trim()] : []))
      : [];
const listOf = (out: unknown, ...keys: string[]): Obj[] => {
  const raw = Array.isArray(out)
    ? out
    : isObj(out)
      ? keys.map((k) => out[k]).find(Array.isArray)
      : [];
  return (Array.isArray(raw) ? raw : []).filter(isObj);
};
const ms = (v: unknown): number | undefined => {
  const s = str(v);
  if (s === undefined) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
};

/** A connector tool (`mail_search`, `notes_read`, …); throws when the call fails. */
export type ToolCall = (tool: string, params: Obj, signal: AbortSignal) => Promise<unknown>;
/** A Mac helper capability (`messages.graph_read`); throws when the call fails. */
export type HelperCall = (capability: string, params: Obj, signal: AbortSignal) => Promise<unknown>;

export interface AppleSourceDeps {
  /** One Apple app's connector tools; undefined while that app is not connected. */
  call: (app: "mail" | "notes" | "calendar" | "reminders") => ToolCall | undefined;
  /** The Mac helper offering `messages.graph_read`; undefined while none is live. */
  helper: () => HelperCall | undefined;
  /**
   * The Host's Mac helper offering `contacts.list` and `contacts.read`, for the Contacts source;
   * undefined while none is live. Absent = Contacts is unavailable on this host.
   */
  contacts?: () => HelperCall | undefined;
  /** The Memory person document a contact is the same person as, so results collapse (optional). */
  contactParent?: ContactsSourceDeps["parentOf"];
  /** The owner's own addresses, to tell sent mail from received mail. */
  ownAddresses: () => string[];
  /** The #1006 check: whether this row is the owner's own content (a trusted list, own calendar). */
  owned?: (app: "notes" | "calendar" | "reminders", row: Obj) => boolean;
  /** Loads what `owned` needs (the sources the owner marked as theirs) before a pass reads rows. */
  refreshTrust?: (app: "notes" | "calendar" | "reminders", signal: AbortSignal) => Promise<void>;
  /**
   * The host's `process.platform` (default: not Windows). On `win32` Notes and Messages are not
   * offered, and a source that cannot read says what would feed it there.
   */
  platform?: string;
  now: () => number;
}

const NOT_CONNECTED = "Apple apps are not connected";
const NO_HELPER = "the Mac helper is not connected";
/** Why an app's source cannot read now, in the host's own terms. */
const WINDOWS_NOT_CONNECTED = {
  mail: "neither Outlook nor a Microsoft 365 or Google account is connected",
  calendar: "neither Outlook nor a Microsoft 365 or Google account is connected",
  reminders: "neither Outlook nor Microsoft To Do (Microsoft 365) is connected",
  notes: NOT_CONNECTED,
} as const;
const notConnected = (deps: AppleSourceDeps, app: keyof typeof WINDOWS_NOT_CONNECTED) =>
  deps.platform === "win32" ? WINDOWS_NOT_CONNECTED[app] : NOT_CONNECTED;
/** Contacts on Windows come from classic Outlook through the Windows helper. */
const WINDOWS_NO_CONTACTS = "classic Outlook is not available through the Windows helper";
const DAY = 86_400_000;
const provOf = (deps: AppleSourceDeps, app: "notes" | "calendar" | "reminders", row: Obj) =>
  deps.owned?.(app, row) === true ? ("owner" as const) : ("untrusted" as const);

/** The most the Apple connector tools return in one call (`limit` 1–500); longer lists are paged. */
export const APPLE_PAGE = 500;
/** The helper clamps a Messages graph read to 200 rows (`messages.graph_chats` / `graph_read`). */
const MESSAGES_PAGE = 200;
/** A safety stop for a list that never ends. */
const MAX_PAGES = 200;

/**
 * Every row of a list the connector returns in pages of at most 500: `offset` skips what was read.
 * `complete` is false when the walk stopped early (a helper that ignores `offset` hands back the
 * same page again, which adds nothing and ends the walk), so the rows are not the whole list and a
 * sweep must delete nothing on them.
 */
async function pagedList(
  fetchPage: (offset: number, size: number) => Promise<Obj[]>,
  idOf: (row: Obj) => string | undefined,
  pageSize: number = APPLE_PAGE,
  /** Smallest page a timeout may shrink to; leave unset to fail on the first timeout. */
  minPageSize?: number,
): Promise<{ rows: Obj[]; complete: boolean }> {
  const rows: Obj[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let size = pageSize;
  for (let page = 0; page < MAX_PAGES; page++) {
    let got: Obj[];
    // A page the Mac cannot answer in time is read again at half the size, and the later pages
    // stay at the size that worked: a slow library is read slowly, not given up on.
    for (;;) {
      try {
        got = await fetchPage(offset, size);
        break;
      } catch (err) {
        if (minPageSize === undefined || !isTimeout(err) || size <= minPageSize) throw err;
        size = Math.max(minPageSize, Math.floor(size / 2));
      }
    }
    let added = 0;
    for (const r of got) {
      const id = idOf(r);
      if (id !== undefined) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      rows.push(r);
      added += 1;
    }
    if (got.length < size) return { rows, complete: true };
    if (added === 0) return { rows, complete: false };
    offset += got.length;
  }
  return { rows, complete: false };
}

/** A read the Mac gave up on (Mail's own search, a helper timeout): worth retrying over less. */
const isTimeout = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : String(err);
  const details = isObj(err) && isObj(err.details) ? err.details : undefined;
  const reason = details === undefined ? undefined : str(details.reason);
  return (
    reason === "timeout" ||
    reason === "search_timeout" ||
    reason === "script_timeout" ||
    /took too long|timed out/i.test(message)
  );
};

// --- mail ------------------------------------------------------------------------------------

/**
 * Mail is read newest first in bounded date windows: one unbounded search over every mailbox is
 * more than Mail can answer in time ("Mail search took too long"). A sweep walks back from `top`
 * (now) one window at a time, a page of 25 at a time inside a window; a first sweep goes on until
 * two years in a row hold no mail, a later one stops at `floor`, where the last sweep began. A
 * window Mail cannot answer is halved and read again (and later windows stay at the size that
 * worked), so a timeout slows the walk and does not fail the source.
 */
interface MailSweep {
  /** ISO: when the sweep began; the next sweep reads from here. */
  top: string;
  /** ISO: the search's `until`; everything newer in this sweep is read. */
  until: string;
  /** ISO: where the last finished sweep began, or null for the first (walk back to the start). */
  floor: string | null;
  /** Days in a row, walking back, with no mail at all. */
  empty: number;
  /** Ids read at the edge of the last full page, which the next page's search returns again. */
  edge?: string[];
}
interface MailCursor {
  /** ISO: the `top` of the last finished sweep, or null before the first. */
  newest: string | null;
  sweep: MailSweep | null;
  /** The window, in days, and the largest one that has not timed out. */
  win: number;
  cap: number;
  /** Searches that have succeeded since the last timeout: enough of them lift `cap` again. */
  ok?: number;
}

const MAIL_START_DAYS = 7;
/** After this many searches in a row without a timeout, the largest window is allowed to double. */
const MAIL_REGROW_AFTER = 20;
const MAIL_MAX_DAYS = 366;
/** A first sweep ends after this many days in a row without mail. */
const MAIL_EMPTY_STOP_DAYS = 730;
/** ... or this far back, whatever is there. */
const MAIL_OLDEST_DAYS = 30 * 366;
/** A sweep re-reads this much of the one before it: mail dated a little before it was delivered. */
const MAIL_OVERLAP_MS = 10 * 60_000;

const isoTime = (v: unknown): string | null => {
  const s = str(v);
  return s !== undefined && !Number.isNaN(Date.parse(s)) ? s : null;
};
const clampDays = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.min(MAIL_MAX_DAYS, Math.max(1, Math.floor(v)))
    : fallback;

/** A stored cursor, including the one an earlier build wrote (`{ newest, until, done }`). */
function mailCursor(raw: unknown, now: number): MailCursor {
  const base = { win: MAIL_START_DAYS, cap: MAIL_MAX_DAYS };
  if (!isObj(raw)) return { newest: null, sweep: null, ...base };
  const newest = isoTime(raw.newest);
  const win = clampDays(raw.win, base.win);
  const cap = Math.max(win, clampDays(raw.cap, base.cap));
  const sw = raw.sweep;
  if (isObj(sw)) {
    const top = isoTime(sw.top);
    const until = isoTime(sw.until);
    if (top !== null && until !== null)
      return {
        newest,
        sweep: {
          top,
          until,
          floor: isoTime(sw.floor),
          empty: typeof sw.empty === "number" ? Math.max(0, sw.empty) : 0,
          ...(Array.isArray(sw.edge)
            ? { edge: sw.edge.filter((x): x is string => typeof x === "string").slice(0, 600) }
            : {}),
        },
        win,
        cap,
      };
  }
  const until = isoTime(raw.until);
  if (!("sweep" in raw) && raw.done !== true && until !== null)
    return {
      newest,
      sweep: { top: new Date(now).toISOString(), until, floor: null, empty: 0 },
      win,
      cap,
    };
  return { newest, sweep: null, win, cap };
}

type MailStep =
  | { kind: "retry"; win: number; cap: number }
  | { kind: "page"; rows: Obj[]; sweep: MailSweep; win: number; cap: number; done: boolean };

export function mailAdapter(deps: AppleSourceDeps): SourceAdapter {
  const summaries = async (call: ToolCall, p: Obj, signal: AbortSignal) =>
    listOf(await call("mail_search", p, signal), "messages", "results");
  const when = (m: Obj) => ms(m.date ?? m.received ?? m.dateReceived ?? m.sentAt);

  /** One search inside the sweep's current window: its rows, and where the sweep stands after it. */
  const step = async (
    call: ToolCall,
    sweep: MailSweep,
    win: number,
    cap: number,
    size: number,
    signal: AbortSignal,
  ): Promise<MailStep> => {
    const until = Date.parse(sweep.until);
    const floor = sweep.floor === null ? Number.NEGATIVE_INFINITY : Date.parse(sweep.floor);
    const since = Math.max(until - win * DAY, floor);
    let rows: Obj[];
    try {
      rows = await summaries(
        call,
        { limit: size, since: new Date(since).toISOString(), until: sweep.until },
        signal,
      );
    } catch (err) {
      if (!isTimeout(err) || win <= 1) throw err;
      const half = Math.max(1, Math.floor(win / 2));
      return { kind: "retry", win: half, cap: half };
    }
    const dates = rows.flatMap((m) => when(m) ?? []);
    const oldest = dates.length === 0 ? undefined : Math.min(...dates);
    let nextUntil: number;
    let edge: string[] = [];
    let nextEmpty = 0;
    let nextWin = win;
    let done = false;
    if (rows.length >= size && oldest !== undefined && oldest > since) {
      // A full page: more of this window lies before its oldest row. The helper's `until` is
      // exclusive, so one second more keeps mail received in that same second.
      nextUntil = oldest + 1000 < until ? oldest + 1000 : oldest;
      edge = rows.flatMap((m) => (when(m) === oldest ? (str(m.id) ?? []) : []));
    } else {
      // The window is read. Move to the one before it, widening over quiet stretches.
      nextUntil = since;
      if (sweep.floor !== null) done = since <= floor;
      else {
        nextEmpty = rows.length === 0 ? sweep.empty + (until - since) / DAY : 0;
        done =
          nextEmpty >= MAIL_EMPTY_STOP_DAYS ||
          nextUntil <= Date.parse(sweep.top) - MAIL_OLDEST_DAYS * DAY;
      }
      if (rows.length * 2 < size) nextWin = Math.min(cap, win * 2);
    }
    return {
      kind: "page",
      rows,
      sweep: {
        top: sweep.top,
        floor: sweep.floor,
        until: new Date(nextUntil).toISOString(),
        empty: nextEmpty,
        ...(edge.length === 0 ? {} : { edge }),
      },
      win: nextWin,
      cap,
      done,
    };
  };

  return {
    id: "mail",
    unavailable: () => (deps.call("mail") === undefined ? notConnected(deps, "mail") : undefined),
    async pull(raw, { signal, limit }): Promise<SourcePull> {
      const call = deps.call("mail");
      if (call === undefined) throw new Error(notConnected(deps, "mail"));
      const now = deps.now();
      const cur = mailCursor(raw, now);
      const size = Math.min(limit, 25);
      const sweep: MailSweep = cur.sweep ?? {
        top: new Date(now).toISOString(),
        until: new Date(now).toISOString(),
        floor:
          cur.newest === null
            ? null
            : new Date(Date.parse(cur.newest) - MAIL_OVERLAP_MS).toISOString(),
        empty: 0,
      };
      const got = await step(call, sweep, Math.min(cur.win, cur.cap), cur.cap, size, signal);
      if (got.kind === "retry") {
        // Too much for Mail in one go: read this window again, smaller, on the next page.
        return {
          items: [],
          cursor: { ...cur, sweep, win: got.win, cap: got.cap, ok: 0 },
          hasMore: true,
        };
      }
      const rows = got.rows;
      const own = new Set(deps.ownAddresses().map((a) => a.toLowerCase()));
      const items: SourceItem[] = [];
      const edge = new Set(sweep.edge ?? []);
      for (const m of rows) {
        const id = str(m.id);
        const at = when(m);
        if (id === undefined || at === undefined || edge.has(id)) continue;
        const full = await call(
          "mail_read",
          {
            id,
            ...(str(m.mailbox) ? { mailbox: m.mailbox } : {}),
            ...(str(m.account) ? { account: m.account } : {}),
          },
          signal,
        ).catch(() => undefined);
        const body = isObj(full)
          ? (str(full.body) ?? str(full.text) ?? str(full.content))
          : undefined;
        const from = str(m.from) ?? (isObj(full) ? str(full.from) : undefined);
        const to = strs(m.to ?? (isObj(full) ? full.to : undefined));
        const cc = strs(m.cc ?? (isObj(full) ? full.cc : undefined));
        const subject = str(m.subject) ?? "(no subject)";
        const text = stripQuotedReplies(body ?? str(m.preview) ?? str(m.snippet) ?? "");
        const sent =
          m.sent === true ||
          /^sent/i.test(str(m.mailbox) ?? "") ||
          (from !== undefined && own.has(addressOf(from).toLowerCase()));
        const thread =
          str(m.threadId) ?? subject.replace(/^((re|fwd?|aw):\s*)+/i, "").toLowerCase();
        // The Message-ID comes from the connector's own `message://` link for this message, never
        // from the body, and only when it has the shape of one (`parseMessageId`).
        // Each candidate in turn: a summary link that is not a `message://` one does not hide a
        // good one in the read result.
        const messageId = [
          m.link,
          isObj(full) ? full.link : undefined,
          isObj(full) && isObj(full.summary) ? full.summary.link : undefined,
        ]
          .map(messageIdFromLink)
          .find((x) => x !== undefined);
        items.push({
          nativeId: id,
          ...(messageId === undefined ? {} : { openRef: messageId }),
          title: subject,
          text: [
            from ? `From: ${from}` : "",
            to.length > 0 ? `To: ${to.join(", ")}` : "",
            cc.length > 0 ? `Cc: ${cc.join(", ")}` : "",
            "",
            text,
          ]
            .join("\n")
            .trim(),
          ...(from === undefined ? {} : { from }),
          createdAt: at,
          provenance: sent ? "owner" : "untrusted",
          tags: ["email", `thread:${thread}`, ...(sent ? ["sent"] : [])],
          parties: [...(from ? [from] : []), ...to, ...cc],
          ...(str(m.account) ? { account: str(m.account) as string } : {}),
        });
      }
      // One bad day (Mail busy, a big mailbox syncing) must not cap the window for good: after a
      // run of searches that all worked, the cap is lifted a step and the window may grow again.
      const okRun = (isObj(raw) && typeof raw.ok === "number" ? raw.ok : 0) + 1;
      const regrow = okRun >= MAIL_REGROW_AFTER && got.cap < MAIL_MAX_DAYS;
      const cap = regrow ? Math.min(MAIL_MAX_DAYS, got.cap * 2) : got.cap;
      const ok = regrow ? 0 : okRun;
      if (!got.done) {
        return {
          items,
          cursor: { newest: cur.newest, sweep: got.sweep, win: got.win, cap, ok },
          hasMore: true,
        };
      }
      // The sweep reached its end: the next one starts where this one did.
      return {
        items,
        cursor: { newest: got.sweep.top, sweep: null, win: got.win, cap, ok },
        hasMore: false,
      };
    },
    async listIds(signal) {
      const call = deps.call("mail");
      if (call === undefined) return { ids: [], complete: false };
      const ids: string[] = [];
      const top = new Date(deps.now()).toISOString();
      let sweep: MailSweep = { top, until: top, floor: null, empty: 0 };
      let win = MAIL_START_DAYS;
      let cap = MAIL_MAX_DAYS;
      for (let n = 0; n < 4000; n++) {
        let got: MailStep;
        try {
          got = await step(call, sweep, win, cap, APPLE_PAGE, signal);
        } catch (err) {
          // Mail would not answer even one day: a partial list must not delete anything.
          if (isTimeout(err)) return { ids, complete: false };
          throw err;
        }
        if (got.kind === "retry") {
          win = got.win;
          cap = got.cap;
          continue;
        }
        const edge = new Set(sweep.edge ?? []);
        for (const m of got.rows) {
          const id = str(m.id);
          if (id !== undefined && !edge.has(id)) ids.push(id);
        }
        if (got.done) return { ids, complete: true };
        sweep = got.sweep;
        win = got.win;
        cap = got.cap;
      }
      return { ids, complete: false };
    },
  };
}

// --- messages --------------------------------------------------------------------------------

/**
 * iMessage through `messages.graph_read` with `includeText` (read-only, ROWID cursor). One document
 * per conversation per day and page, `from:` the first sender. Deletions are not visible in
 * `chat.db` rows already read; Rebuild drops them.
 */
type ChatMeta = { handles: string[]; isGroup: boolean };

/** How long one pass reuses the chat directory it already read. */
const CHATS_TTL_MS = 5 * 60_000;

/**
 * The other side of a one-to-one chat is in its id (`iMessage;-;+15551110000`), so a chat the
 * directory does not list still says who it is with. A group's id says nothing.
 */
const handleOfChatId = (chatId: string): string | undefined =>
  /^[^;]+;-;(.+)$/.exec(chatId)?.[1]?.trim() || undefined;

/**
 * The cursor: `row` is where the next page starts. A chat that had no known members when its rows
 * were read (a group made after the directory was read, or one an older helper cannot list) is
 * not indexed then, and is kept in `skipped` with the row it was first seen at; once the
 * directory knows it, those rows are read again (`only` that chat, up to `stop`, the row the
 * read had reached) so it is indexed after all.
 */
interface MessagesCursor {
  row: number;
  skipped?: { chatId: string; row: number }[];
  only?: string[];
  stop?: number;
}
const MAX_SKIPPED = 200;

function messagesCursor(raw: unknown): MessagesCursor {
  if (!isObj(raw)) return { row: 0 };
  const skipped = Array.isArray(raw.skipped)
    ? raw.skipped.flatMap((x): { chatId: string; row: number }[] =>
        isObj(x) && typeof x.chatId === "string" && typeof x.row === "number"
          ? [{ chatId: x.chatId, row: x.row }]
          : [],
      )
    : [];
  return {
    row: typeof raw.row === "number" ? raw.row : 0,
    ...(skipped.length > 0 ? { skipped } : {}),
    ...(Array.isArray(raw.only) && typeof raw.stop === "number"
      ? { only: raw.only.filter((x): x is string => typeof x === "string"), stop: raw.stop }
      : {}),
  };
}

export function messagesAdapter(deps: AppleSourceDeps): SourceAdapter {
  // Every chat with its participants, so a day's document names who it is with even when the day
  // holds only the owner's own messages: the owner's "never index" list works on those names.
  let directory: { chats: Map<string, ChatMeta>; at: number } | undefined;
  const chatDirectory = async (helper: HelperCall, signal: AbortSignal, fresh: boolean) => {
    const now = deps.now();
    if (!fresh && directory !== undefined && now - directory.at < CHATS_TTL_MS)
      return directory.chats;
    const { rows } = await pagedList(
      async (offset) =>
        listOf(
          await helper(
            "messages.graph_chats",
            { limit: MESSAGES_PAGE, ...(offset > 0 ? { offset } : {}) },
            signal,
          ),
          "chats",
        ),
      (c) => str(c.chatId),
      MESSAGES_PAGE,
    );
    const chats = new Map<string, ChatMeta>();
    for (const c of rows) {
      const id = str(c.chatId);
      if (id !== undefined)
        chats.set(id, { handles: strs(c.handles), isGroup: c.isGroup === true });
    }
    directory = { chats, at: now };
    return chats;
  };
  return {
    id: "messages",
    unavailable: () => (deps.helper() === undefined ? NO_HELPER : undefined),
    async pull(raw, { signal, limit }): Promise<SourcePull> {
      const helper = deps.helper();
      if (helper === undefined) throw new Error(NO_HELPER);
      const cur = messagesCursor(raw);
      let fetched = raw === null;
      let chats = await chatDirectory(helper, signal, raw === null);
      let skipped = cur.skipped ?? [];
      let only = cur.only;
      let stop = cur.stop;
      let row = cur.row;
      // A chat skipped before that the directory now knows: read its rows again (only its).
      const known = skipped.filter((x) => chats.has(x.chatId));
      if (known.length > 0 && only === undefined) {
        only = known.map((x) => x.chatId);
        stop = row;
        row = Math.min(...known.map((x) => x.row));
        skipped = skipped.filter((x) => !chats.has(x.chatId));
      }
      const pageStart = row;
      const out = await helper(
        "messages.graph_read",
        { sinceCursor: row, limit: Math.min(limit * 2, MESSAGES_PAGE), includeText: true },
        signal,
      );
      const days = new Map<
        string,
        {
          chatId: string;
          day: string;
          lines: string[];
          handles: Set<string>;
          from?: string;
          inbound: boolean;
          first: number;
          last: number;
        }
      >();
      for (const m of listOf(out, "messages")) {
        const chatId = str(m.chatId);
        const sentAt = str(m.sentAt);
        const text = str(m.text);
        if (chatId === undefined || sentAt === undefined || text === undefined) continue;
        const at = Date.parse(sentAt);
        const day = sentAt.slice(0, 10);
        const key = `${chatId}\u0000${day}`;
        let d = days.get(key);
        if (d === undefined) {
          d = { chatId, day, lines: [], handles: new Set(), inbound: false, first: at, last: at };
          days.set(key, d);
        }
        const inbound = m.direction === "in";
        const handle = str(m.handle);
        if (inbound) {
          d.inbound = true;
          if (handle !== undefined) {
            d.handles.add(handle);
            d.from ??= handle;
          }
        }
        d.lines.push(`${inbound ? (handle ?? "them") : "me"}: ${text}`);
        d.first = Math.min(d.first, at);
        d.last = Math.max(d.last, at);
      }
      // A chat the directory does not have may be new: read the directory again, once.
      if (
        !fetched &&
        [...days.values()].some(
          (d) => !chats.has(d.chatId) && handleOfChatId(d.chatId) === undefined,
        )
      ) {
        chats = await chatDirectory(helper, signal, true);
        fetched = true;
      }
      const cursor = isObj(out) && typeof out.cursor === "number" ? out.cursor : row;
      // Re-reading a skipped chat's rows keeps only that chat, until the page that reaches where
      // the read had got to: its rows past that point are new for every chat, so it keeps all.
      const filtering = only !== undefined && stop !== undefined && cursor < stop;
      const items: SourceItem[] = [...days.values()].flatMap((d): SourceItem[] => {
        if (filtering && !only?.includes(d.chatId)) return [];
        const meta = chats.get(d.chatId);
        const direct = handleOfChatId(d.chatId);
        // A chat the directory does not have (an older helper cannot list past 200) and whose id
        // does not name the other person is a group of unknown members: its participants cannot
        // be checked against the "never index" list, so it is not indexed.
        if (meta === undefined && direct === undefined) {
          if (!filtering && !skipped.some((x) => x.chatId === d.chatId))
            skipped = [...skipped, { chatId: d.chatId, row: pageStart }].slice(-MAX_SKIPPED);
          return [];
        }
        const people = [
          ...new Set([
            ...(meta?.handles ?? []),
            ...d.handles,
            ...(direct === undefined ? [] : [direct]),
          ]),
        ];
        return [
          {
            nativeId: `${d.chatId}|${d.day}|${row}`,
            title: `Messages with ${people.join(", ") || "a conversation"} · ${d.day}`,
            text: `Participants: ${people.join(", ")}\n${d.lines.join("\n")}`,
            ...(d.from === undefined ? {} : { from: d.from }),
            createdAt: d.first,
            updatedAt: d.last,
            provenance: d.inbound ? "untrusted" : "owner",
            tags: ["message", "imessage", ...(meta?.isGroup === true ? ["group"] : [])],
            parties: people,
            chatId: d.chatId,
          },
        ];
      });
      const hasMore = isObj(out) && out.hasMore === true && cursor > row;
      if (!hasMore) directory = undefined;
      const next: MessagesCursor = {
        row: cursor,
        ...(skipped.length > 0 ? { skipped } : {}),
        ...(filtering && hasMore ? { only, stop } : {}),
      };
      return { items, cursor: next, hasMore };
    },
  };
}

// --- notes -----------------------------------------------------------------------------------

/** How long one pass reuses the list of notes it already read (a pass is a few pages in a row). */
const NOTES_LIST_TTL_MS = 5 * 60_000;
/** Notes' first page size (the helper's cap is 500) and the smallest a timeout shrinks it to. */
const NOTES_PAGE = 250;
const NOTES_MIN_PAGE = 10;

/** Notes by modified date: the list is cheap, bodies are read only for notes changed since. */
export function notesAdapter(deps: AppleSourceDeps): SourceAdapter {
  /**
   * `NOTES_PAGE` notes a call, `offset` for the rest: a long library is read in as many calls as
   * it takes. Notes is slow to enumerate, so a page it cannot answer in time is halved (down to
   * `NOTES_MIN_PAGE`) and the rest of the walk stays at the size that worked.
   */
  const list = (call: ToolCall, signal: AbortSignal) =>
    pagedList(
      async (offset, size) =>
        listOf(
          await call("notes_list", { limit: size, ...(offset > 0 ? { offset } : {}) }, signal),
          "notes",
        ),
      (n) => str(n.id),
      NOTES_PAGE,
      NOTES_MIN_PAGE,
    );
  // The list a pass is working through, so each page of changed notes does not read it all again.
  let listed: { rows: Obj[]; at: number } | undefined;
  return {
    id: "notes",
    unavailable: () => (deps.call("notes") === undefined ? notConnected(deps, "notes") : undefined),
    async pull(raw, { signal, limit }): Promise<SourcePull> {
      const call = deps.call("notes");
      if (call === undefined) throw new Error(notConnected(deps, "notes"));
      await deps.refreshTrust?.("notes", signal);
      const since = isObj(raw) && typeof raw.mod === "number" ? raw.mod : 0;
      const now = deps.now();
      // A first page (no cursor) always reads the list again; the pages after it reuse it.
      let rows: Obj[];
      if (raw !== null && listed !== undefined && now - listed.at < NOTES_LIST_TTL_MS) {
        rows = listed.rows;
      } else {
        rows = (await list(call, signal)).rows;
        listed = { rows, at: now };
      }
      const changed = rows
        .map((n) => ({ n, at: ms(n.modified ?? n.modifiedAt ?? n.updatedAt) ?? 0 }))
        .filter((x) => x.at > since)
        .sort((a, b) => a.at - b.at);
      const page = changed.slice(0, Math.min(limit, 50));
      const items: SourceItem[] = [];
      for (const { n, at } of page) {
        const id = str(n.id);
        if (id === undefined) continue;
        const full = await call("notes_read", { id, maxLength: 100_000 }, signal).catch(
          () => undefined,
        );
        const f = isObj(full) ? full : {};
        const body =
          str(f.text) ??
          str(f.plainText) ??
          str(f.plain) ??
          htmlToText(str(f.body) ?? str(f.html) ?? "");
        const title = str(n.title) ?? str(f.title) ?? "Untitled note";
        items.push({
          nativeId: id,
          title,
          text: body,
          createdAt: ms(n.created ?? n.createdAt) ?? at,
          updatedAt: at,
          provenance: provOf(deps, "notes", { ...n, ...f }),
          tags: ["note", ...(str(n.folder) ? [`folder:${str(n.folder)}`] : [])],
          ...(str(n.folder) ? { path: str(n.folder) as string } : {}),
        });
      }
      const last = page.at(-1)?.at ?? since;
      const hasMore = changed.length > page.length;
      if (!hasMore) listed = undefined;
      return { items, cursor: { mod: last }, hasMore };
    },
    async listIds(signal) {
      const call = deps.call("notes");
      if (call === undefined) return { ids: [], complete: false };
      const { rows, complete } = await list(call, signal);
      return { ids: rows.flatMap((n) => str(n.id) ?? []), complete };
    },
  };
}

// --- calendar --------------------------------------------------------------------------------

/** The past three years and the next twelve months, in windows under the connector's 366 days. */
const CAL_WINDOWS: [number, number][] = [
  [-1095, -730],
  [-730, -365],
  [-365, 0],
  [0, 365],
];
/** The smallest range a full page is split down to. */
const CAL_MIN_SPAN = 3_600_000;
/** The most calls one window of the calendar may take, however full it is. */
const CAL_MAX_CALLS = 40;
/** After the first pass: recent past and the year ahead, every pass (changes are caught by hash). */
const CAL_LIVE: [number, number] = [-30, 365];

export function calendarAdapter(deps: AppleSourceDeps): SourceAdapter {
  /**
   * The events from `from` to `to`, at most 500 a call: a range that fills the page is split in
   * half and each half read again, down to an hour, so a busy calendar is read whole. Two things
   * keep that from running away: a split whose halves return mostly the same events (events that
   * span the whole range show up in both) is not split further, and a range gets at most
   * `CAL_MAX_CALLS` calls. Either way the read says it is partial.
   */
  const events = async (
    call: ToolCall,
    from: number,
    to: number,
    signal: AbortSignal,
    budget: { left: number },
    first?: Obj[],
  ): Promise<{ rows: Obj[]; complete: boolean }> => {
    const read = async (a: number, b: number): Promise<Obj[]> => {
      budget.left -= 1;
      return listOf(
        await call(
          "calendar_list_events",
          { from: new Date(a).toISOString(), to: new Date(b).toISOString(), limit: APPLE_PAGE },
          signal,
        ),
        "events",
      );
    };
    if (first === undefined && budget.left <= 0) return { rows: [], complete: false };
    const rows = first ?? (await read(from, to));
    if (rows.length < APPLE_PAGE) return { rows, complete: true };
    if (to - from <= CAL_MIN_SPAN || budget.left < 2) return { rows, complete: false };
    const mid = Math.floor((from + to) / 2);
    const left = await read(from, mid);
    const right = await read(mid, to);
    const key = (e: Obj) => `${str(e.id) ?? ""}\u0000${str(e.start) ?? ""}`;
    const merge = (...lists: Obj[][]) => {
      const seen = new Set<string>();
      return lists.flat().filter((e) => {
        const k = key(e);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };
    const inRight = new Set(right.map(key));
    const shared = left.filter((e) => inRight.has(key(e))).length;
    // Events that span the split are in both halves; when most of what a half returned is shared,
    // splitting again only repeats them.
    // Only when both halves are full: a half that is short is whole (all of it is read), and the
    // other half still has events past the page, which splitting it further reads.
    if (
      left.length >= APPLE_PAGE &&
      right.length >= APPLE_PAGE &&
      shared * 2 >= Math.min(left.length, right.length)
    )
      return { rows: merge(rows, left, right), complete: false };
    const a = await events(call, from, mid, signal, budget, left);
    const b = await events(call, mid, to, signal, budget, right);
    return { rows: merge(a.rows, b.rows), complete: a.complete && b.complete };
  };
  const window = (call: ToolCall, [a, b]: [number, number], signal: AbortSignal) => {
    const now = deps.now();
    return events(call, now + a * DAY, now + b * DAY, signal, { left: CAL_MAX_CALLS });
  };
  const itemOf = (e: Obj): SourceItem | undefined => {
    const id = str(e.id);
    const start = ms(e.start);
    if (id === undefined || start === undefined) return undefined;
    const attendees = listOf(e.attendees ?? []);
    const people = attendees.flatMap((a) =>
      [str(a.name), str(a.email)].filter((x): x is string => x !== undefined),
    );
    const organizer = isObj(e.organizer)
      ? [str(e.organizer.name), str(e.organizer.email)]
      : [str(e.organizer)];
    const names = attendees
      .map((a) => str(a.name) ?? str(a.email))
      .filter((x): x is string => x !== undefined);
    const title = str(e.title) ?? "(no title)";
    const end = str(e.end);
    return {
      nativeId: id,
      title,
      text: [
        `When: ${str(e.start)}${end ? ` – ${end}` : ""}`,
        str(e.location) ? `Where: ${str(e.location)}` : "",
        names.length > 0 ? `With: ${names.join(", ")}` : "",
        str(e.notes) ?? str(e.description) ?? "",
      ]
        .filter((x) => x !== "")
        .join("\n"),
      createdAt: start,
      provenance: provOf(deps, "calendar", e),
      tags: ["event", ...(str(e.calendar) ? [`calendar:${str(e.calendar)}`] : [])],
      parties: [...people, ...organizer.filter((x): x is string => x !== undefined)],
    };
  };
  return {
    id: "calendar",
    unavailable: () =>
      deps.call("calendar") === undefined ? notConnected(deps, "calendar") : undefined,
    async pull(raw, { signal }): Promise<SourcePull> {
      const call = deps.call("calendar");
      if (call === undefined) throw new Error(notConnected(deps, "calendar"));
      await deps.refreshTrust?.("calendar", signal);
      const w = isObj(raw) && typeof raw.w === "number" ? raw.w : 0;
      const range = w < CAL_WINDOWS.length ? (CAL_WINDOWS[w] as [number, number]) : CAL_LIVE;
      const items = (await window(call, range, signal)).rows.flatMap((e) => itemOf(e) ?? []);
      const next = Math.min(w + 1, CAL_WINDOWS.length);
      return { items, cursor: { w: next }, hasMore: w + 1 < CAL_WINDOWS.length };
    },
    async listIds(signal) {
      const call = deps.call("calendar");
      if (call === undefined) return { ids: [], complete: false };
      const ids: string[] = [];
      let complete = true;
      for (const r of CAL_WINDOWS) {
        const got = await window(call, r, signal);
        complete &&= got.complete;
        for (const e of got.rows) ids.push(str(e.id) ?? "");
      }
      return { ids: ids.filter((x) => x !== ""), complete };
    },
  };
}

// --- reminders -------------------------------------------------------------------------------

/** Reminders have no change token: every pass reads them all and the content hash skips the rest. */
export function remindersAdapter(deps: AppleSourceDeps): SourceAdapter {
  /** Open, then done: each 500 a call, soonest due first, `offset` for the rest. */
  const all = async (call: ToolCall, signal: AbortSignal) => {
    const rows: Obj[] = [];
    let complete = true;
    for (const completed of [false, true]) {
      const got = await pagedList(
        async (offset) =>
          listOf(
            await call(
              "reminders_list",
              { completed, limit: APPLE_PAGE, ...(offset > 0 ? { offset } : {}) },
              signal,
            ),
            "reminders",
          ),
        (r) => str(r.id),
      );
      rows.push(...got.rows);
      complete &&= got.complete;
    }
    return { rows, complete };
  };
  return {
    id: "reminders",
    unavailable: () =>
      deps.call("reminders") === undefined ? notConnected(deps, "reminders") : undefined,
    async pull(_raw, { signal }): Promise<SourcePull> {
      const call = deps.call("reminders");
      if (call === undefined) throw new Error(notConnected(deps, "reminders"));
      await deps.refreshTrust?.("reminders", signal);
      const items: SourceItem[] = [];
      for (const r of (await all(call, signal)).rows) {
        const id = str(r.id);
        if (id === undefined) continue;
        const due = str(r.due) ?? str(r.dueDate);
        const done = r.completed === true;
        items.push({
          nativeId: id,
          title: str(r.title) ?? "Reminder",
          text: [
            due ? `Due: ${due}` : "",
            done ? "Status: done" : "Status: open",
            str(r.list) ? `List: ${str(r.list)}` : "",
            str(r.notes) ?? "",
          ]
            .filter((x) => x !== "")
            .join("\n"),
          createdAt: ms(due) ?? ms(r.created ?? r.createdAt) ?? deps.now(),
          provenance: provOf(deps, "reminders", r),
          tags: ["reminder", done ? "done" : "open"],
        });
      }
      return { items, cursor: { at: deps.now() }, hasMore: false };
    },
    async listIds(signal) {
      const call = deps.call("reminders");
      if (call === undefined) return { ids: [], complete: false };
      const { rows, complete } = await all(call, signal);
      return { ids: rows.flatMap((r) => str(r.id) ?? []), complete };
    },
  };
}

export function appleAdapters(deps: AppleSourceDeps): SourceAdapter[] {
  const windows = deps.platform === "win32";
  return [
    mailAdapter(deps),
    // iMessage and Apple Notes exist only on a Mac: no row for them on Windows.
    ...(windows ? [] : [messagesAdapter(deps), notesAdapter(deps)]),
    calendarAdapter(deps),
    remindersAdapter(deps),
    contactsAdapter({
      helper: deps.contacts ?? (() => undefined),
      ...(deps.contactParent === undefined ? {} : { parentOf: deps.contactParent }),
      ...(windows ? { noHelper: WINDOWS_NO_CONTACTS } : {}),
      now: deps.now,
    }),
  ];
}
