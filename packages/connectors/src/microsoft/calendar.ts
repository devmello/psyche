import { type JsonObject, PsycheError } from "@psyche/protocol";
import { type EventInput, type EventView, MAX_RANGE_DAYS } from "../google/calendar.ts";
import { type GraphApi, GraphError, utcDateTime } from "./api.ts";
import {
  type GraphRecurrence,
  graphRecurrenceToRrule,
  rruleToGraphRecurrence,
} from "./recurrence.ts";

/**
 * Outlook calendar and contacts over Graph, shaped like the Google connector's views so the
 * calendar tools behave the same on both (feature M6, "same acceptance as M5"). Times go to
 * Graph in UTC and come back in UTC (`Prefer: outlook.timezone="UTC"`). Graph sends invitations
 * whenever an event has attendees, so the binding treats every event with attendees as an
 * invite (`calendarBinding`). Recurrence converts both ways for the shapes Graph can express
 * (`recurrence.ts`); anything else is refused on write.
 */

interface GraphEvent {
  id?: string;
  subject?: string;
  bodyPreview?: string;
  location?: { displayName?: string };
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
  organizer?: { emailAddress?: { address?: string } };
  attendees?: {
    emailAddress?: { address?: string };
    status?: { response?: string };
    type?: string;
  }[];
  webLink?: string;
  lastModifiedDateTime?: string;
  recurrence?: GraphRecurrence;
}

const str = (v: unknown, max = 5000) => (typeof v === "string" ? v.slice(0, max) : "");
const UTC_PREFER = { prefer: 'outlook.timezone="UTC"' };

function time(t: GraphEvent["start"], allDay: boolean): unknown {
  const dt = str(t?.dateTime, 40);
  if (allDay) return { date: dt.slice(0, 10) };
  return { dateTime: dt === "" ? "" : `${dt.replace(/\.\d+$/, "")}Z` };
}

export function graphEventView(e: GraphEvent): EventView & { recurrence?: string[] } {
  const allDay = e.isAllDay === true;
  const rrule = e.recurrence === undefined ? undefined : graphRecurrenceToRrule(e.recurrence);
  return {
    ...(rrule === undefined ? {} : { recurrence: [rrule] }),
    id: str(e.id, 500),
    status: e.isCancelled === true ? "cancelled" : "confirmed",
    summary: str(e.subject, 1000),
    description: str(e.bodyPreview),
    location: str(e.location?.displayName, 500),
    start: time(e.start, allDay),
    end: time(e.end, allDay),
    organizer: str(e.organizer?.emailAddress?.address, 320),
    attendees: (e.attendees ?? []).map((a) => ({
      email: str(a.emailAddress?.address, 320),
      responseStatus: str(a.status?.response, 40),
    })),
    htmlLink: str(e.webLink, 2000),
    updated: str(e.lastModifiedDateTime, 40),
  };
}

/** An IANA zone name the runtime knows, or `invalid_params`. */
function ianaZone(zone: string, name: string): string {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
  } catch {
    throw new PsycheError(
      "invalid_params",
      `${name}.timeZone "${zone.slice(0, 40)}" is not an IANA time zone`,
    );
  }
  return zone;
}

/**
 * A timed value as wall-clock time in `zone`. An instant (with `Z` or an offset) is converted
 * with Intl; a bare date-time already is the wall clock in its zone and passes through.
 */
function wallClock(input: string, zone: string): { dateTime: string; timeZone: string } {
  const bare = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?(\.\d+)?$/.exec(input);
  if (bare !== null) {
    return { dateTime: `${bare[1]}T${bare[2]}${bare[3] ?? ":00"}`, timeZone: zone };
  }
  const instant = new Date(input);
  if (Number.isNaN(instant.getTime())) {
    throw new PsycheError("invalid_params", `not a date-time: ${input.slice(0, 40)}`);
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  return {
    dateTime: `${date}T${part("hour")}:${part("minute")}:${part("second")}`,
    timeZone: zone,
  };
}

/**
 * `zone` is the event's own zone (`timeZone`), or undefined for UTC. A timed start in a zone
 * becomes wall-clock time there (`wallClock`); without a zone the value is sent in UTC.
 */
function graphTime(
  t: EventInput["start"] | undefined,
  name: string,
  zone: string | undefined,
): { dateTime: string; timeZone: string } | undefined {
  if (t === undefined) return undefined;
  if (typeof t.date === "string") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date))
      throw new PsycheError("invalid_params", `${name}.date must be YYYY-MM-DD`);
    return { dateTime: `${t.date}T00:00:00`, timeZone: "UTC" };
  }
  if (typeof t.dateTime === "string") {
    return zone === undefined ? utcDateTime(t.dateTime) : wallClock(t.dateTime, zone);
  }
  throw new PsycheError("invalid_params", `${name} needs dateTime or date`);
}

/**
 * Google-shaped event input → Graph event resource (partial for updates). `recurrence: []` on an
 * update sends `recurrence: null`, which removes the series' recurrence; on create it is a no-op.
 */
export function graphEventBody(
  e: Partial<EventInput>,
  opts: { update?: boolean } = {},
): JsonObject {
  const out: JsonObject = {};
  if (e.summary !== undefined) out.subject = e.summary;
  if (e.description !== undefined) out.body = { contentType: "text", content: e.description };
  if (e.location !== undefined) out.location = { displayName: e.location };
  const recurring = e.recurrence !== undefined && e.recurrence.length > 0;
  // A recurring timed event is anchored in its own IANA zone: wall-clock times there, so a weekly
  // event keeps its weekday and hour across DST. Without a zone it stays in UTC, as before. The
  // end takes its own zone, else the start's. Non-recurring events stay in UTC.
  const timed =
    e.start !== undefined && e.start.date === undefined && typeof e.start.dateTime === "string";
  const startZone =
    recurring && timed && e.start?.timeZone !== undefined
      ? ianaZone(e.start.timeZone, "start")
      : undefined;
  const endTimeZone = e.end?.timeZone ?? e.start?.timeZone;
  const endZone =
    recurring && timed && endTimeZone !== undefined ? ianaZone(endTimeZone, "end") : undefined;
  const start = graphTime(e.start, "start", recurring ? startZone : undefined);
  const end = graphTime(e.end, "end", recurring ? endZone : undefined);
  if (start !== undefined) out.start = start;
  if (end !== undefined) out.end = end;
  if (e.start?.date !== undefined) out.isAllDay = true;
  if (e.recurrence !== undefined) {
    if (e.recurrence.length === 0) {
      if (opts.update === true) out.recurrence = null;
    } else {
      // The series' date is the day of its start as sent (the start's zone, or UTC without one).
      const rec = rruleToGraphRecurrence(e.recurrence, start?.dateTime.slice(0, 10));
      out.recurrence =
        startZone === undefined
          ? rec
          : { ...rec, range: { ...rec.range, recurrenceTimeZone: startZone } };
    }
  }
  if (e.attendees !== undefined) {
    out.attendees = e.attendees.map((a) => ({
      emailAddress: { address: a.email },
      type: a.optional === true ? "optional" : "required",
    }));
  }
  return out;
}

function calendarPath(calendarId: string | undefined): string {
  return calendarId === undefined || calendarId === "primary"
    ? "/me/calendar"
    : `/me/calendars/${encodeURIComponent(calendarId)}`;
}

export class GraphCalendar {
  readonly #api: GraphApi;

  constructor(api: GraphApi) {
    this.#api = api;
  }

  async listCalendars(signal?: AbortSignal) {
    const r = await this.#api.json<{ value?: Record<string, unknown>[] }>("/me/calendars", {
      query: { $select: "id,name,isDefaultCalendar,canEdit,owner", $top: 100 },
      ...(signal === undefined ? {} : { signal }),
    });
    return (r.value ?? []).map((c) => ({
      id: str(c.id, 500),
      summary: str(c.name, 500),
      primary: c.isDefaultCalendar === true,
      accessRole: c.canEdit === true ? "writer" : "reader",
    }));
  }

  async listEvents(
    input: {
      calendarId?: string;
      timeMin: string;
      timeMax: string;
      query?: string;
      maxResults?: number;
    },
    signal?: AbortSignal,
  ): Promise<{ events: EventView[] }> {
    const a = Date.parse(input.timeMin);
    const b = Date.parse(input.timeMax);
    if (Number.isNaN(a) || Number.isNaN(b) || b <= a) {
      throw new PsycheError(
        "invalid_params",
        "timeMin and timeMax must be RFC 3339, timeMin first",
      );
    }
    if (b - a > MAX_RANGE_DAYS * 86_400_000) {
      throw new PsycheError("invalid_params", `ranges are limited to ${MAX_RANGE_DAYS} days`);
    }
    const r = await this.#api.json<{ value?: GraphEvent[] }>(
      `${calendarPath(input.calendarId)}/calendarView`,
      {
        query: {
          startDateTime: new Date(a).toISOString(),
          endDateTime: new Date(b).toISOString(),
          $top: Math.min(Math.max(input.maxResults ?? 50, 1), 250),
          $orderby: "start/dateTime",
        },
        headers: UTC_PREFER,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    let events = (r.value ?? []).map(graphEventView);
    const q = input.query?.toLowerCase();
    if (q !== undefined && q !== "") {
      events = events.filter((e) =>
        `${e.summary} ${e.description} ${e.location}`.toLowerCase().includes(q),
      );
    }
    return { events };
  }

  /** Busy intervals per address (`getSchedule`); free slots are dropped. */
  async freeBusy(
    input: { timeMin: string; timeMax: string; calendarIds: string[] },
    signal?: AbortSignal,
  ): Promise<{ calendars: Record<string, { busy: { start: string; end: string }[] }> }> {
    const r = await this.#api.json<{
      value?: {
        scheduleId?: string;
        scheduleItems?: {
          status?: string;
          start?: { dateTime?: string };
          end?: { dateTime?: string };
        }[];
      }[];
    }>("/me/calendar/getSchedule", {
      method: "POST",
      json: {
        schedules: input.calendarIds.slice(0, 50),
        startTime: utcDateTime(input.timeMin),
        endTime: utcDateTime(input.timeMax),
        availabilityViewInterval: 30,
      },
      headers: UTC_PREFER,
      ...(signal === undefined ? {} : { signal }),
    });
    const calendars: Record<string, { busy: { start: string; end: string }[] }> = {};
    for (const s of r.value ?? []) {
      calendars[str(s.scheduleId, 320)] = {
        busy: (s.scheduleItems ?? [])
          .filter((i) => i.status !== "free")
          .map((i) => ({
            start: `${str(i.start?.dateTime, 40).replace(/\.\d+$/, "")}Z`,
            end: `${str(i.end?.dateTime, 40).replace(/\.\d+$/, "")}Z`,
          })),
      };
    }
    return { calendars };
  }

  async createEvent(
    calendarId: string,
    event: EventInput,
    signal?: AbortSignal,
  ): Promise<EventView> {
    const e = await this.#api.json<GraphEvent>(`${calendarPath(calendarId)}/events`, {
      method: "POST",
      json: graphEventBody(event),
      headers: UTC_PREFER,
      ...(signal === undefined ? {} : { signal }),
    });
    return graphEventView(e);
  }

  async updateEvent(
    eventId: string,
    event: Partial<EventInput>,
    signal?: AbortSignal,
  ): Promise<EventView> {
    const e = await this.#api.json<GraphEvent>(`/me/events/${encodeURIComponent(eventId)}`, {
      method: "PATCH",
      json: graphEventBody(event, { update: true }),
      headers: UTC_PREFER,
      ...(signal === undefined ? {} : { signal }),
    });
    return graphEventView(e);
  }

  async deleteEvent(eventId: string, signal?: AbortSignal): Promise<void> {
    await this.#api.request(`/me/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** `calendarView/delta` over a rolling window; a lost token (410) restarts it. */
  async sync(deltaLink: string | undefined, now: number, signal?: AbortSignal) {
    const start = "/me/calendarView/delta";
    let full = deltaLink === undefined;
    let url = deltaLink ?? start;
    const changed: string[] = [];
    for (let i = 0; i < 20; i++) {
      let page: {
        value?: { id?: string }[];
        "@odata.nextLink"?: string;
        "@odata.deltaLink"?: string;
      };
      try {
        page = await this.#api.json(url, {
          ...(url === start
            ? {
                query: {
                  startDateTime: new Date(now - 7 * 86_400_000).toISOString(),
                  endDateTime: new Date(now + 365 * 86_400_000).toISOString(),
                },
              }
            : {}),
          headers: UTC_PREFER,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (err) {
        if (
          err instanceof GraphError &&
          (err.status === 410 || err.graphCode === "syncStateNotFound") &&
          !full
        ) {
          full = true;
          url = start;
          continue;
        }
        throw err;
      }
      for (const v of page.value ?? []) if (!full && typeof v.id === "string") changed.push(v.id);
      if (typeof page["@odata.deltaLink"] === "string") {
        this.#api.url(page["@odata.deltaLink"]);
        return { deltaLink: page["@odata.deltaLink"], changed, full };
      }
      if (typeof page["@odata.nextLink"] !== "string") break;
      url = page["@odata.nextLink"];
    }
    return { deltaLink, changed, full };
  }

  async searchContacts(query: string | undefined, maxResults: number, signal?: AbortSignal) {
    const q = query?.replace(/["\\]/g, " ").trim();
    const r = await this.#api.json<{ value?: Record<string, unknown>[] }>("/me/contacts", {
      query: {
        $top: Math.min(Math.max(maxResults, 1), 100),
        $select: "id,displayName,emailAddresses,businessPhones,mobilePhone,homePhones,companyName",
        ...(q === undefined || q === "" ? { $orderby: "displayName" } : { $search: `"${q}"` }),
      },
      ...(signal === undefined ? {} : { signal }),
    });
    return (r.value ?? []).map((c) => ({
      id: str(c.id, 500),
      name: str(c.displayName, 300),
      emails: (Array.isArray(c.emailAddresses) ? c.emailAddresses : [])
        .map((e) => str((e as { address?: unknown }).address, 320))
        .filter(Boolean),
      phones: [
        ...(Array.isArray(c.businessPhones) ? c.businessPhones : []),
        c.mobilePhone,
        ...(Array.isArray(c.homePhones) ? c.homePhones : []),
      ]
        .map((p) => str(p, 60))
        .filter(Boolean),
      company: str(c.companyName, 300),
    }));
  }
}

export { GraphError };
