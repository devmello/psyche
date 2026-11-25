import { createHash } from "node:crypto";
import { readTool } from "../mail/tools.ts";
import type { ToolLookup } from "../proposals/service.ts";
import type {
  CalendarEventInfo,
  Json,
  MailDraftInfo,
  MailThreadInfo,
  ReadRegistry,
  ReminderInfo,
} from "./adapters/types.ts";

/**
 * The live read registry the adapters judge against (docs/design/night-shift-2026.md §2.2). It is
 * backed by READ-ONLY connector tools only: `reads` is a `ToolLookup` the caller filtered to tools
 * whose side effect is `none` or `read`, and this module refuses a tool that is not (it never holds
 * a connector object with write methods). Every method fails closed: a missing tool or an answer it
 * cannot read throws, which refuses the stage (capture) or marks the item stale (check). `null` only
 * ever means "the tool said it is not there".
 */

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** `Name <a@b.c>` or `a@b.c` to a lower-case bare address; "" when there is none. */
function address(v: unknown): string {
  const s = typeof v === "string" ? v : str(rec(v).address ?? rec(v).email);
  const m = /<([^>]+)>/.exec(s);
  return (m?.[1] ?? s).trim().toLowerCase();
}

/** Addresses from a string (comma separated), an array of strings or `{address}` objects. */
function addresses(v: unknown): string[] {
  const parts = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return parts.map(address).filter((a) => a !== "");
}

const hash = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

export interface ReadRegistryDeps {
  /** Read-only connector tools, by bare name (`mail_read`, `gmail_read_thread`, ...). */
  reads: ToolLookup;
  /** How far ahead and back a calendar lookup searches. Default 30 days either way. */
  calendarWindowDays?: number;
  now?: () => number;
}

export function createReadRegistry(deps: ReadRegistryDeps): ReadRegistry {
  const has = (tool: string): boolean => {
    const reg = deps.reads.get(tool);
    if (reg === undefined) return false;
    const effect = reg.spec.sideEffect;
    // A tool that is not a pure read is never reachable from here.
    if (effect !== "read" && effect !== "none") {
      throw new Error(`read registry: ${tool} is not a read tool`);
    }
    return true;
  };
  const read = async (tool: string, params: Record<string, unknown>): Promise<unknown> => {
    if (!has(tool)) throw new Error(`read registry: ${tool} is not connected`);
    return readTool(deps.reads, tool, params);
  };
  const day = 86_400_000;

  /** One message as `mail_read` / `mail_read_message` return it. */
  const message = (m: Record<string, unknown>) => ({
    id: str(m.id ?? m.messageId),
    from: addresses(m.from),
    to: addresses(m.to),
    cc: addresses(m.cc),
    replyTo: m.replyTo === undefined ? undefined : addresses(m.replyTo),
    at: Date.parse(str(m.date ?? m.at ?? m.receivedAt)),
  });

  return {
    async mailThread(ref): Promise<MailThreadInfo | null> {
      if (ref.threadId !== undefined && has("gmail_read_thread")) {
        const out = rec(await read("gmail_read_thread", { id: ref.threadId }));
        const msgs = list(out.messages).map((m) => message(rec(m)));
        if (msgs.length === 0) return null;
        const newest = msgs.reduce((a, b) => (b.at > a.at ? b : a));
        return {
          threadId: ref.threadId,
          newestMessageId: newest.id,
          count: msgs.length,
          participants: [...new Set(msgs.flatMap((m) => [...m.from, ...m.to, ...m.cc]))],
        };
      }
      const id = ref.messageId ?? ref.threadId;
      if (id === undefined) throw new Error("read registry: no message id");
      const tool = has("mail_read") ? "mail_read" : "mail_read_message";
      const out = await read(tool, {
        id,
        ...(ref.mailbox === undefined ? {} : { mailbox: ref.mailbox }),
        ...(ref.account === undefined ? {} : { account: ref.account }),
      });
      if (out === null || out === undefined) return null;
      const m = message(rec(out));
      if (m.id === "") return null;
      // A single message is its own thread here: the connector exposes no thread view, so a newer
      // message in the conversation is seen by its id and count only when the thread tool exists.
      return {
        threadId: id,
        newestMessageId: m.id,
        count: 1,
        participants: [...new Set([...m.from, ...m.to, ...m.cc])],
      };
    },

    async mailDraft(draftId): Promise<MailDraftInfo | null> {
      const tool = has("mail_read") ? "mail_read" : undefined;
      if (tool === undefined) throw new Error("read registry: drafts are not readable");
      const out = rec(await read(tool, { id: draftId }));
      if (str(out.id) === "") return null;
      return {
        to: addresses(out.to),
        cc: addresses(out.cc),
        bcc: addresses(out.bcc),
        subject: str(out.subject),
        body: str(out.body),
        inReplyTo: str(out.inReplyTo),
        attachments: list(out.attachments).map((a) => str(rec(a).name ?? a)),
      };
    },

    /**
     * The recipients a reply really goes to: Reply-To, else From, plus To and Cc for reply-all. The
     * connector must say whether there is a Reply-To (`replyTo` present, empty when none): an answer
     * without the key could hide a Reply-To that points elsewhere, so it is refused.
     */
    async mailReplyRecipients(ref): Promise<string[] | null> {
      const tool = has("mail_read") ? "mail_read" : "mail_read_message";
      const out = await read(tool, {
        id: ref.messageId,
        ...(ref.mailbox === undefined ? {} : { mailbox: ref.mailbox }),
        ...(ref.account === undefined ? {} : { account: ref.account }),
      });
      if (out === null || out === undefined) return null;
      const m = message(rec(out));
      if (m.id === "") return null;
      if (m.replyTo === undefined) throw new Error("read registry: Reply-To is not reported");
      const first = m.replyTo.length > 0 ? m.replyTo : m.from;
      if (first.length === 0) throw new Error("read registry: no sender");
      const all = ref.replyAll ? [...first, ...m.to, ...m.cc] : first;
      return [...new Set(all)];
    },

    /** Which of these the owner has ever written to: their sent mail, one lookup per address. */
    async mailSentTo(addrs): Promise<string[]> {
      const out: string[] = [];
      for (const a of addrs.slice(0, 20)) {
        let found: boolean;
        if (has("gmail_search_threads")) {
          const r = rec(await read("gmail_search_threads", { query: `in:sent to:${a}`, limit: 1 }));
          found = list(r.threads ?? r.items ?? (Array.isArray(r) ? r : [])).length > 0;
        } else if (has("mail_search")) {
          const r = await read("mail_search", { mailbox: "Sent", query: a, limit: 1 });
          const items = Array.isArray(r) ? r : list(rec(r).messages ?? rec(r).items);
          found = items.length > 0;
        } else {
          throw new Error("read registry: sent mail is not searchable");
        }
        if (found) out.push(a);
      }
      return out;
    },

    async calendarEvent(ref): Promise<CalendarEventInfo | null> {
      const now = (deps.now ?? Date.now)();
      const span = (deps.calendarWindowDays ?? 30) * day;
      const r = await read("calendar_list_events", {
        from: new Date(now - span).toISOString(),
        to: new Date(now + span).toISOString(),
        ...(ref.calendarId === undefined ? {} : { calendarId: ref.calendarId }),
      });
      const events = Array.isArray(r) ? r : list(rec(r).events);
      const hit = events.map(rec).find((e) => str(e.id) === ref.id);
      return hit === undefined ? null : eventInfo(hit, ref.calendarId);
    },

    async calendarFind(q): Promise<CalendarEventInfo[]> {
      const at = Date.parse(q.start);
      if (!Number.isFinite(at)) throw new Error("read registry: bad start");
      const r = await read("calendar_list_events", {
        from: new Date(at - day).toISOString(),
        to: new Date(at + 2 * day).toISOString(),
        ...(q.calendarId === undefined ? {} : { calendarId: q.calendarId }),
      });
      const events = Array.isArray(r) ? r : list(rec(r).events);
      return events
        .map(rec)
        .filter((e) => str(e.title ?? e.summary) === q.title && Date.parse(str(e.start)) === at)
        .map((e) => eventInfo(e, q.calendarId));
    },

    async reminder(id): Promise<ReminderInfo | null> {
      const r = await read("reminders_list", { includeCompleted: true });
      const items = Array.isArray(r) ? r : list(rec(r).reminders ?? rec(r).items);
      const hit = items.map(rec).find((x) => str(x.id) === id);
      return hit === undefined ? null : reminderInfo(hit);
    },

    async remindersFind(q): Promise<ReminderInfo[]> {
      const r = await read("reminders_list", {
        includeCompleted: true,
        ...(q.listId === undefined ? {} : { listId: q.listId }),
      });
      const items = Array.isArray(r) ? r : list(rec(r).reminders ?? rec(r).items);
      return items
        .map(rec)
        .filter((x) => str(x.title) === q.title)
        .map(reminderInfo);
    },
  };

  function eventInfo(e: Record<string, unknown>, calendarId?: string): CalendarEventInfo {
    const attendees = addresses(e.attendees);
    const fields: Record<string, Json> = {
      title: str(e.title ?? e.summary),
      start: str(e.start),
      end: str(e.end),
      location: str(e.location),
      notes: str(e.notes ?? e.description),
    };
    return {
      id: str(e.id),
      ...(calendarId === undefined ? {} : { calendarId }),
      // An etag if the connector has one; otherwise a hash of what the adapters judge.
      etag: str(e.etag ?? e.updatedAt ?? e.modifiedAt) || hash({ fields, attendees }),
      title: str(e.title ?? e.summary),
      start: str(e.start),
      end: str(e.end),
      attendees,
      fields,
    };
  }

  function reminderInfo(r: Record<string, unknown>): ReminderInfo {
    const fields: Record<string, Json> = {
      title: str(r.title),
      notes: str(r.notes),
      due: str(r.due ?? r.dueDate),
    };
    return {
      id: str(r.id),
      listId: str(r.listId ?? r.list),
      modifiedAt: str(r.modifiedAt ?? r.updatedAt) || hash(fields),
      title: str(r.title),
      completed: r.completed === true,
      fields,
    };
  }
}
