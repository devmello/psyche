import { asRecord, preview, type RowInput, splitTool, str, toolPrefix } from "./common.ts";

export { splitTool };

import type {
  Adapter,
  CalendarEventInfo,
  CaptureResult,
  CheckResult,
  InverseCall,
  Json,
  ReadRegistry,
  StagedCall,
} from "./types.ts";

/**
 * Calendar (§2.3): create and update only for events with no other attendees, because a change to
 * a shared event notifies people. Stale on an etag change, a deleted event, an added attendee, or
 * (create) a duplicate with the same title and start. Inverse: restore the snapshot, or delete
 * what a create made (a destructive child bound to the created id).
 *
 * Connector tools skip schema validation, so extra keys reach the connector. The adapter knows two
 * exact argument shapes and refuses any key outside them:
 * - `flat` (Apple Calendar): `title`, `start`, `end`, ... at the top level, `id` to update;
 * - `event` (Google, Microsoft): `{ calendarId?, eventId?, event: {...}, sendUpdates? }`.
 * The connector comes from the `mcp__<connector>__` prefix; a bare name is judged by its shape.
 * `event.attendees` must be absent or empty, and `sendUpdates` absent or "none" (Microsoft has no
 * such key). The event captured and checked is the one the connector will write: `eventId` (or
 * `id`) in `calendarId` (default calendar when absent).
 */

const TOOLS = ["calendar_create_event", "calendar_update_event"] as const;

export type CalendarFlavor = "apple" | "google" | "microsoft";

export interface CalendarDeps {
  /**
   * The type of a live connector id, from the connector registry. Never guessed from the name. A
   * prefixed call whose connector is not known here is refused; a bare name is judged by shape.
   */
  flavorOf?: (connectorId: string) => CalendarFlavor | undefined;
}

const FLAT_KEYS = [
  "calendarId",
  "title",
  "start",
  "end",
  "allDay",
  "location",
  "notes",
  "url",
  "alarms",
  "recurrence",
  "availability",
] as const;
const EVENT_KEYS = [
  "summary",
  "description",
  "location",
  "start",
  "end",
  "attendees",
  "recurrence",
] as const;

interface Norm {
  shape: "flat" | "event";
  create: boolean;
  /** Written fields by name (the connector's own names). */
  fields: Record<string, Json>;
  calendarId?: string;
  eventId?: string;
  title?: string;
  start?: string;
}

type Refusal = { reason: string };

function startKey(v: unknown): string | undefined {
  if (typeof v === "string" && v !== "") return v;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return str(o.dateTime) ?? str(o.date);
  }
  return undefined;
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(o).find((k) => !allowed.includes(k));
}

function norm(call: StagedCall, deps: CalendarDeps): Norm | Refusal {
  const { connector, bare } = splitTool(call.tool);
  if (!TOOLS.includes(bare as (typeof TOOLS)[number])) return { reason: "unknown_tool" };
  const create = bare === "calendar_create_event";
  const a = call.args;
  const flavor = connector ? deps.flavorOf?.(connector) : undefined;
  if (connector && !flavor) return { reason: "unknown_connector" };
  const eventShaped = "event" in a;
  if (flavor === "apple" && eventShaped) return { reason: "shape_mismatch" };
  if ((flavor === "google" || flavor === "microsoft") && !eventShaped) {
    return { reason: "shape_mismatch" };
  }

  if (!eventShaped) {
    const extra = onlyKeys(a, create ? FLAT_KEYS : [...FLAT_KEYS, "id", "span"]);
    if (extra) return { reason: `unknown_key:${extra}` };
    if (a.span !== undefined && a.span !== "this") return { reason: "series_refused" };
    const fields: Record<string, Json> = {};
    for (const k of FLAT_KEYS)
      if (k !== "calendarId" && a[k] !== undefined) fields[k] = a[k] as Json;
    const out: Norm = {
      shape: "flat",
      create,
      fields,
      calendarId: str(a.calendarId),
      title: str(a.title),
      start: startKey(a.start),
    };
    if (a.calendarId !== undefined && !out.calendarId) return { reason: "bad_event" };
    if (create) return out.title && out.start ? out : { reason: "bad_event" };
    out.eventId = str(a.id);
    return out.eventId ? out : { reason: "bad_event" };
  }

  const extra = onlyKeys(
    a,
    create
      ? ["calendarId", "event", "sendUpdates"]
      : ["calendarId", "eventId", "event", "sendUpdates"],
  );
  if (extra) return { reason: `unknown_key:${extra}` };
  if (a.sendUpdates !== undefined) {
    if (flavor === "microsoft") return { reason: "unknown_key:sendUpdates" };
    if (a.sendUpdates !== "none") return { reason: "send_updates_refused" };
  }
  const ev = a.event;
  if (ev === null || typeof ev !== "object" || Array.isArray(ev)) return { reason: "bad_event" };
  const e = ev as Record<string, unknown>;
  const badKey = onlyKeys(e, EVENT_KEYS);
  if (badKey) return { reason: `unknown_key:event.${badKey}` };
  if (e.attendees !== undefined && !(Array.isArray(e.attendees) && e.attendees.length === 0)) {
    return { reason: "attendees_refused" };
  }
  const fields: Record<string, Json> = {};
  for (const k of EVENT_KEYS) if (k !== "attendees" && e[k] !== undefined) fields[k] = e[k] as Json;
  const out: Norm = {
    shape: "event",
    create,
    fields,
    calendarId: str(a.calendarId),
    title: str(e.summary),
    start: startKey(e.start),
  };
  if (a.calendarId !== undefined && !out.calendarId) return { reason: "bad_event" };
  if (create) return out.title && out.start ? out : { reason: "bad_event" };
  out.eventId = str(a.eventId);
  return out.eventId ? out : { reason: "bad_event" };
}

async function readEvent(
  registry: ReadRegistry,
  ref: { id: string; calendarId?: string },
): Promise<CalendarEventInfo | null | "unreadable" | "mismatch"> {
  try {
    const ev = await registry.calendarEvent(ref);
    if (!ev) return null;
    // The registry must return the event the connector will write, not a lookalike.
    if (ev.id !== ref.id) return "mismatch";
    if (
      ref.calendarId !== undefined &&
      ev.calendarId !== undefined &&
      ev.calendarId !== ref.calendarId
    ) {
      return "mismatch";
    }
    return ev;
  } catch {
    return "unreadable";
  }
}

const targetKey = (calendarId: string | undefined, id: string) =>
  calendarId ? `${calendarId}/${id}` : id;

export function calendarAdapter(registry: ReadRegistry, deps: CalendarDeps = {}): Adapter {
  const refOf = (pre: Record<string, Json>) => ({
    id: String(pre.id),
    calendarId: typeof pre.calendarId === "string" ? pre.calendarId : undefined,
  });

  async function look(ref: {
    id: string;
    calendarId?: string;
  }): Promise<CalendarEventInfo | Refusal> {
    const ev = await readEvent(registry, ref);
    if (ev === "unreadable") return { reason: "calendar_unreadable" };
    if (ev === "mismatch") return { reason: "event_mismatch" };
    if (!ev) return { reason: "event_gone" };
    return ev;
  }

  return {
    tools: TOOLS,

    async capture(call): Promise<CaptureResult> {
      const n = norm(call, deps);
      if ("reason" in n) return { ok: false, reason: n.reason };

      if (n.create) {
        let dupes: CalendarEventInfo[];
        try {
          dupes = await registry.calendarFind({
            title: n.title as string,
            start: n.start as string,
            calendarId: n.calendarId,
          });
        } catch {
          return { ok: false, reason: "calendar_unreadable" };
        }
        if (dupes.length > 0) return { ok: false, reason: "duplicate" };
        return {
          ok: true,
          target: `create:${n.start}|${n.title}`,
          precondition: {
            create: true,
            shape: n.shape,
            title: n.title as string,
            start: n.start as string,
            calendarId: n.calendarId ?? null,
          },
          before: {},
        };
      }

      const ref = { id: n.eventId as string, calendarId: n.calendarId };
      const ev = await look(ref);
      if ("reason" in ev) return { ok: false, reason: ev.reason };
      if (ev.attendees.length > 0) return { ok: false, reason: "attendees_refused" };

      const keys = Object.keys(n.fields).sort();
      const before: Record<string, Json> = {};
      for (const k of keys) before[k] = ev.fields[k] ?? null;
      return {
        ok: true,
        target: targetKey(n.calendarId, ev.id),
        precondition: {
          shape: n.shape,
          id: ev.id,
          calendarId: n.calendarId ?? null,
          etag: ev.etag,
          keys,
        },
        before,
      };
    },

    async check(_call, capture): Promise<CheckResult> {
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
      const ev = await look(refOf(pre));
      if ("reason" in ev) return { fresh: false, reason: ev.reason };
      if (ev.attendees.length > 0) return { fresh: false, reason: "attendee_added" };
      if (ev.etag !== pre.etag) return { fresh: false, reason: "changed" };
      return { fresh: true };
    },

    preview(call, capture) {
      const n = norm(call, deps);
      if ("reason" in n) return preview("calendar", "Refused event", [["Reason", n.reason]]);
      const before = asRecord(capture.before);
      const rows: RowInput[] = [];
      if (!n.create) rows.push(["Event", capture.target]);
      rows.push(["Calendar", n.calendarId ?? "(default)"]);
      // Every field that will be written, with its name, so nothing rides along unseen.
      for (const k of Object.keys(n.fields).sort()) {
        rows.push([k, n.create ? show(n.fields[k]) : `${show(before[k])} -> ${show(n.fields[k])}`]);
      }
      return preview("calendar", n.create ? "Add an event" : "Change an event", rows);
    },

    inverse(call, capture, created): InverseCall | undefined {
      const n = norm(call, deps);
      if ("reason" in n) return undefined;
      const pre = asRecord(capture.precondition);
      const cal = typeof pre.calendarId === "string" ? pre.calendarId : undefined;
      if (n.create) {
        // Deleting needs the id the applied create returned; without it there is no inverse.
        if (!created?.id) return undefined;
        return {
          tool: `${toolPrefix(call.tool)}calendar_delete_event`,
          args:
            n.shape === "flat"
              ? { id: created.id }
              : { ...(cal ? { calendarId: cal } : {}), eventId: created.id },
          destructive: true,
        };
      }
      const before = asRecord(capture.before);
      return {
        tool: call.tool,
        args:
          n.shape === "flat"
            ? { id: String(pre.id), ...(cal ? { calendarId: cal } : {}), ...before }
            : { ...(cal ? { calendarId: cal } : {}), eventId: String(pre.id), event: before },
      };
    },

    async postState(call, capture, created): Promise<Json> {
      const pre = asRecord(capture.precondition);
      const ref = pre.create === true ? (created ? { id: created.id } : undefined) : refOf(pre);
      void call;
      if (!ref) return null;
      const ev = await readEvent(registry, ref);
      return typeof ev === "object" && ev ? { etag: ev.etag } : null;
    },

    async checkInverse(_call, capture, post, created): Promise<CheckResult> {
      const pre = asRecord(capture.precondition);
      const ref = pre.create === true ? (created ? { id: created.id } : undefined) : refOf(pre);
      if (!ref) return { fresh: false, reason: "no_created_id" };
      const ev = await look(ref);
      if ("reason" in ev) return { fresh: false, reason: ev.reason };
      if (ev.attendees.length > 0) return { fresh: false, reason: "attendee_added" };
      if (ev.etag !== asRecord(post).etag) return { fresh: false, reason: "changed_since_apply" };
      return { fresh: true };
    },
  };
}

function show(v: unknown): string {
  return v === undefined || v === null ? "(none)" : typeof v === "string" ? v : JSON.stringify(v);
}
