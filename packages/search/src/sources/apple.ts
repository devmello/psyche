import { addressOf } from "./exclusion.ts";
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
  /** The owner's own addresses, to tell sent mail from received mail. */
  ownAddresses: () => string[];
  /** The #1006 check: whether this row is the owner's own content (a trusted list, own calendar). */
  owned?: (app: "notes" | "calendar" | "reminders", row: Obj) => boolean;
  /** Loads what `owned` needs (the sources the owner marked as theirs) before a pass reads rows. */
  refreshTrust?: (app: "notes" | "calendar" | "reminders", signal: AbortSignal) => Promise<void>;
  now: () => number;
}

const NOT_CONNECTED = "Apple apps are not connected";
const NO_HELPER = "the Mac helper is not connected";
const DAY = 86_400_000;
const provOf = (deps: AppleSourceDeps, app: "notes" | "calendar" | "reminders", row: Obj) =>
  deps.owned?.(app, row) === true ? ("owner" as const) : ("untrusted" as const);

// --- mail ------------------------------------------------------------------------------------

/** Mail is read newest first: `until` walks back to the oldest, then `newest` follows new mail. */
interface MailCursor {
  newest: string | null;
  until: string | null;
  done: boolean;
}

export function mailAdapter(deps: AppleSourceDeps): SourceAdapter {
  const summaries = async (call: ToolCall, p: Obj, signal: AbortSignal) =>
    listOf(await call("mail_search", p, signal), "messages", "results");
  const when = (m: Obj) => ms(m.date ?? m.received ?? m.dateReceived ?? m.sentAt);
  return {
    id: "mail",
    unavailable: () => (deps.call("mail") === undefined ? NOT_CONNECTED : undefined),
    async pull(raw, { signal, limit }): Promise<SourcePull> {
      const call = deps.call("mail");
      if (call === undefined) throw new Error(NOT_CONNECTED);
      const cur: MailCursor = isObj(raw)
        ? (raw as unknown as MailCursor)
        : { newest: null, until: null, done: false };
      const size = Math.min(limit, 25);
      const params: Obj = { limit: size };
      if (cur.done && cur.newest !== null) params.since = cur.newest;
      else if (cur.until !== null) params.until = cur.until;
      const rows = await summaries(call, params, signal);
      const own = new Set(deps.ownAddresses().map((a) => a.toLowerCase()));
      const items: SourceItem[] = [];
      let oldest = cur.until === null ? Number.POSITIVE_INFINITY : Date.parse(cur.until);
      let newest = cur.newest === null ? 0 : Date.parse(cur.newest);
      for (const m of rows) {
        const id = str(m.id);
        const at = when(m);
        if (id === undefined || at === undefined) continue;
        oldest = Math.min(oldest, at);
        newest = Math.max(newest, at);
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
        items.push({
          nativeId: id,
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
      const iso = (t: number) => new Date(t).toISOString();
      const next: MailCursor = { ...cur, newest: newest > 0 ? iso(newest) : cur.newest };
      if (cur.done) return { items, cursor: next, hasMore: rows.length >= size };
      // Walking back: stop when the page is short or did not move past the frontier.
      const moved =
        Number.isFinite(oldest) && (cur.until === null || oldest < Date.parse(cur.until));
      next.until = Number.isFinite(oldest) ? iso(oldest) : cur.until;
      if (rows.length < size || !moved) {
        next.done = true;
        return { items, cursor: next, hasMore: false };
      }
      return { items, cursor: next, hasMore: true };
    },
    async listIds(signal) {
      const call = deps.call("mail");
      if (call === undefined) return { ids: [], complete: false };
      const ids: string[] = [];
      let until: string | undefined;
      for (let page = 0; page < 400; page++) {
        const rows = await summaries(call, { limit: 500, ...(until ? { until } : {}) }, signal);
        let oldest = Number.POSITIVE_INFINITY;
        for (const m of rows) {
          const id = str(m.id);
          if (id !== undefined) ids.push(id);
          oldest = Math.min(oldest, when(m) ?? oldest);
        }
        if (rows.length < 500) return { ids, complete: true };
        if (!Number.isFinite(oldest) || (until !== undefined && oldest >= Date.parse(until)))
          return { ids, complete: false };
        until = new Date(oldest).toISOString();
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
export function messagesAdapter(deps: AppleSourceDeps): SourceAdapter {
  return {
    id: "messages",
    unavailable: () => (deps.helper() === undefined ? NO_HELPER : undefined),
    async pull(raw, { signal, limit }): Promise<SourcePull> {
      const helper = deps.helper();
      if (helper === undefined) throw new Error(NO_HELPER);
      const row = isObj(raw) && typeof raw.row === "number" ? raw.row : 0;
      const chatsOut = await helper("messages.graph_chats", { limit: 500 }, signal);
      const chats = new Map<string, { handles: string[]; isGroup: boolean }>();
      for (const c of listOf(chatsOut, "chats")) {
        const id = str(c.chatId);
        if (id !== undefined)
          chats.set(id, { handles: strs(c.handles), isGroup: c.isGroup === true });
      }
      const out = await helper(
        "messages.graph_read",
        { sinceCursor: row, limit: Math.min(limit * 2, 500), includeText: true },
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
      const items: SourceItem[] = [...days.values()].map((d) => {
        const meta = chats.get(d.chatId);
        const people = [...new Set([...(meta?.handles ?? []), ...d.handles])];
        return {
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
        };
      });
      const cursor = isObj(out) && typeof out.cursor === "number" ? out.cursor : row;
      return {
        items,
        cursor: { row: cursor },
        hasMore: isObj(out) && out.hasMore === true && cursor > row,
      };
    },
  };
}

// --- notes -----------------------------------------------------------------------------------

/** Notes by modified date: the list is cheap, bodies are read only for notes changed since. */
export function notesAdapter(deps: AppleSourceDeps): SourceAdapter {
  const list = async (call: ToolCall, signal: AbortSignal) =>
    listOf(await call("notes_list", { limit: 5000 }, signal), "notes");
  return {
    id: "notes",
    unavailable: () => (deps.call("notes") === undefined ? NOT_CONNECTED : undefined),
    async pull(raw, { signal, limit }): Promise<SourcePull> {
      const call = deps.call("notes");
      if (call === undefined) throw new Error(NOT_CONNECTED);
      await deps.refreshTrust?.("notes", signal);
      const since = isObj(raw) && typeof raw.mod === "number" ? raw.mod : 0;
      const changed = (await list(call, signal))
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
      return { items, cursor: { mod: last }, hasMore: changed.length > page.length };
    },
    async listIds(signal) {
      const call = deps.call("notes");
      if (call === undefined) return { ids: [], complete: false };
      const rows = await list(call, signal);
      return { ids: rows.flatMap((n) => str(n.id) ?? []), complete: rows.length < 5000 };
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
/** After the first pass: recent past and the year ahead, every pass (changes are caught by hash). */
const CAL_LIVE: [number, number] = [-30, 365];

export function calendarAdapter(deps: AppleSourceDeps): SourceAdapter {
  const window = async (call: ToolCall, [a, b]: [number, number], signal: AbortSignal) => {
    const now = deps.now();
    const out = await call(
      "calendar_list_events",
      {
        from: new Date(now + a * DAY).toISOString(),
        to: new Date(now + b * DAY).toISOString(),
        limit: 2000,
      },
      signal,
    );
    return listOf(out, "events");
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
    unavailable: () => (deps.call("calendar") === undefined ? NOT_CONNECTED : undefined),
    async pull(raw, { signal }): Promise<SourcePull> {
      const call = deps.call("calendar");
      if (call === undefined) throw new Error(NOT_CONNECTED);
      await deps.refreshTrust?.("calendar", signal);
      const w = isObj(raw) && typeof raw.w === "number" ? raw.w : 0;
      const range = w < CAL_WINDOWS.length ? (CAL_WINDOWS[w] as [number, number]) : CAL_LIVE;
      const items = (await window(call, range, signal)).flatMap((e) => itemOf(e) ?? []);
      const next = Math.min(w + 1, CAL_WINDOWS.length);
      return { items, cursor: { w: next }, hasMore: w + 1 < CAL_WINDOWS.length };
    },
    async listIds(signal) {
      const call = deps.call("calendar");
      if (call === undefined) return { ids: [], complete: false };
      const ids: string[] = [];
      for (const r of CAL_WINDOWS)
        for (const e of await window(call, r, signal)) ids.push(str(e.id) ?? "");
      return { ids: ids.filter((x) => x !== ""), complete: true };
    },
  };
}

// --- reminders -------------------------------------------------------------------------------

/** Reminders have no change token: every pass reads them all and the content hash skips the rest. */
export function remindersAdapter(deps: AppleSourceDeps): SourceAdapter {
  const all = async (call: ToolCall, signal: AbortSignal) => {
    const rows: Obj[] = [];
    for (const completed of [false, true])
      rows.push(
        ...listOf(await call("reminders_list", { completed, limit: 5000 }, signal), "reminders"),
      );
    return rows;
  };
  return {
    id: "reminders",
    unavailable: () => (deps.call("reminders") === undefined ? NOT_CONNECTED : undefined),
    async pull(_raw, { signal }): Promise<SourcePull> {
      const call = deps.call("reminders");
      if (call === undefined) throw new Error(NOT_CONNECTED);
      await deps.refreshTrust?.("reminders", signal);
      const items: SourceItem[] = [];
      for (const r of await all(call, signal)) {
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
      return { ids: (await all(call, signal)).flatMap((r) => str(r.id) ?? []), complete: true };
    },
  };
}

export function appleAdapters(deps: AppleSourceDeps): SourceAdapter[] {
  return [
    mailAdapter(deps),
    messagesAdapter(deps),
    notesAdapter(deps),
    calendarAdapter(deps),
    remindersAdapter(deps),
  ];
}
