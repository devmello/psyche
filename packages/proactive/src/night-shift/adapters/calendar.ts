import { asRecord, preview, str } from "./common.ts";
import type {
  Adapter,
  CalendarEventInfo,
  CheckResult,
  InverseCall,
  Json,
  ReadRegistry,
} from "./types.ts";

/**
 * Calendar (§2.3): create and update only for events with no other attendees, because a change to
 * a shared event notifies people. Stale on an etag change, a deleted event, an added attendee, or
 * (create) a duplicate with the same title and start. Inverse: restore the snapshot, or delete
 * what a create made (a destructive child bound to the created id).
 */

const TOOLS = ["calendar_create_event", "calendar_update_event"] as const;

/** Arguments that name people. Any non-empty value refuses, for create and update alike. */
const ATTENDEE_KEYS = ["attendees", "invitees", "guests", "participants", "emails"] as const;

/** Keys that are not event fields. */
const NON_FIELD = new Set(["id", "span", "calendarId"]);

function hasPeople(args: Record<string, unknown>): boolean {
  return ATTENDEE_KEYS.some((k) => {
    const v = args[k];
    return v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);
  });
}

function touched(args: Record<string, unknown>): string[] {
  return Object.keys(args)
    .filter((k) => !NON_FIELD.has(k))
    .sort();
}

async function readEvent(
  registry: ReadRegistry,
  id: string,
): Promise<CalendarEventInfo | null | "unreadable"> {
  try {
    return await registry.calendarEvent(id);
  } catch {
    return "unreadable";
  }
}

export function calendarAdapter(registry: ReadRegistry): Adapter {
  return {
    tools: TOOLS,

    async capture(call) {
      const a = call.args;
      if (hasPeople(a)) return { ok: false, reason: "attendees_refused" };

      if (call.tool === "calendar_create_event") {
        const title = str(a.title);
        const start = str(a.start);
        if (!title || !start) return { ok: false, reason: "bad_event" };
        let dupes: CalendarEventInfo[];
        try {
          dupes = await registry.calendarFind({ title, start, calendarId: str(a.calendarId) });
        } catch {
          return { ok: false, reason: "calendar_unreadable" };
        }
        if (dupes.length > 0) return { ok: false, reason: "duplicate" };
        return {
          ok: true,
          target: `create:${start}|${title}`,
          precondition: { create: true, title, start, calendarId: str(a.calendarId) ?? null },
          before: {},
        };
      }

      // A series-wide change touches events this check cannot see: refuse it (fail closed).
      if (a.span === "future") return { ok: false, reason: "series_refused" };
      const id = str(a.id);
      if (!id) return { ok: false, reason: "bad_event" };
      const ev = await readEvent(registry, id);
      if (ev === "unreadable") return { ok: false, reason: "calendar_unreadable" };
      if (!ev) return { ok: false, reason: "event_gone" };
      if (ev.attendees.length > 0) return { ok: false, reason: "attendees_refused" };

      const keys = touched(a);
      const before: Record<string, Json> = {};
      for (const k of keys) before[k] = ev.fields[k] ?? null;
      return {
        ok: true,
        target: ev.id,
        precondition: { etag: ev.etag, keys },
        before,
      };
    },

    async check(call, capture): Promise<CheckResult> {
      const pre = asRecord(capture.precondition);
      if (pre.create === true) {
        const title = str(pre.title);
        const start = str(pre.start);
        if (!title || !start) return { fresh: false, reason: "bad_event" };
        try {
          const dupes = await registry.calendarFind({
            title,
            start,
            calendarId: typeof pre.calendarId === "string" ? pre.calendarId : undefined,
          });
          return dupes.length > 0 ? { fresh: false, reason: "duplicate" } : { fresh: true };
        } catch {
          return { fresh: false, reason: "calendar_unreadable" };
        }
      }
      const ev = await readEvent(registry, capture.target);
      if (ev === "unreadable") return { fresh: false, reason: "calendar_unreadable" };
      if (!ev) return { fresh: false, reason: "event_gone" };
      if (ev.attendees.length > 0) return { fresh: false, reason: "attendee_added" };
      if (ev.etag !== pre.etag) return { fresh: false, reason: "changed" };
      void call;
      return { fresh: true };
    },

    preview(call, capture) {
      const a = call.args;
      if (call.tool === "calendar_create_event") {
        return preview("calendar", "Add an event", [
          ["Title", a.title],
          ["Start", a.start],
          ["End", a.end],
          ["Location", a.location],
          ["Notes", a.notes],
        ]);
      }
      const before = asRecord(capture.before);
      const rows: Array<[string, unknown]> = [];
      for (const k of touched(a)) rows.push([k, `${plainOf(before[k])} -> ${plainOf(a[k])}`]);
      return preview("calendar", "Change an event", [["Event", capture.target], ...rows]);
    },

    inverse(call, capture, created): InverseCall | undefined {
      if (call.tool === "calendar_create_event") {
        // Deleting needs the id the applied create returned; without it there is no inverse.
        if (!created?.id) return undefined;
        return { tool: "calendar_delete_event", args: { id: created.id }, destructive: true };
      }
      return {
        tool: "calendar_update_event",
        args: { id: capture.target, ...asRecord(capture.before) },
      };
    },

    async postState(call, capture, created): Promise<Json> {
      const id = call.tool === "calendar_create_event" ? created?.id : capture.target;
      if (!id) return null;
      const ev = await readEvent(registry, id);
      return ev === "unreadable" || !ev ? null : { etag: ev.etag };
    },

    async checkInverse(call, capture, post, created): Promise<CheckResult> {
      const id = call.tool === "calendar_create_event" ? created?.id : capture.target;
      if (!id) return { fresh: false, reason: "no_created_id" };
      const ev = await readEvent(registry, id);
      if (ev === "unreadable") return { fresh: false, reason: "calendar_unreadable" };
      if (!ev) return { fresh: false, reason: "event_gone" };
      if (ev.attendees.length > 0) return { fresh: false, reason: "attendee_added" };
      if (ev.etag !== asRecord(post).etag) return { fresh: false, reason: "changed_since_apply" };
      return { fresh: true };
    },
  };
}

function plainOf(v: unknown): string {
  return v === undefined || v === null ? "(none)" : typeof v === "string" ? v : JSON.stringify(v);
}
