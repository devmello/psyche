import { type JsonObject, PsycheError } from "@psyche/protocol";
import { type EventInput, type EventView, MAX_RANGE_DAYS } from "../google/calendar.ts";
import { type GraphApi, GraphError, utcDateTime } from "./api.ts";

/**
 * Outlook calendar and contacts over Graph, shaped like the Google connector's views so the
 * calendar tools behave the same on both (feature M6, "same acceptance as M5"). Times go to
 * Graph in UTC and come back in UTC (`Prefer: outlook.timezone="UTC"`). Graph sends invitations
 * whenever an event has attendees, so the binding treats every event with attendees as an
 * invite (`calendarBinding`). Recurrence rules are not translated yet.
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
}

const str = (v: unknown, max = 5000) => (typeof v === "string" ? v.slice(0, max) : "");
const UTC_PREFER = { prefer: 'outlook.timezone="UTC"' };

function time(t: GraphEvent["start"], allDay: boolean): unknown {
  const dt = str(t?.dateTime, 40);
  if (allDay) return { date: dt.slice(0, 10) };
  return { dateTime: dt === "" ? "" : `${dt.replace(/\.\d+$/, "")}Z` };
}

export function graphEventView(e: GraphEvent): EventView {
  const allDay = e.isAllDay === true;
  return {
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

function graphTime(t: EventInput["start"] | undefined, name: string) {
  if (t === undefined) return undefined;
  if (typeof t.date === "string") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date))
      throw new PsycheError("invalid_params", `${name}.date must be YYYY-MM-DD`);
    return { dateTime: `${t.date}T00:00:00`, timeZone: "UTC" };
  }
  if (typeof t.dateTime === "string") return utcDateTime(t.dateTime);
  throw new PsycheError("invalid_params", `${name} needs dateTime or date`);
}

/** Google-shaped event input → Graph event resource (partial for updates). */
export function graphEventBody(e: Partial<EventInput>): JsonObject {
  if (e.recurrence !== undefined && e.recurrence.length > 0) {
    throw new PsycheError("invalid_params", "recurring events are not supported on Microsoft yet");
  }
  const out: JsonObject = {};
  if (e.summary !== undefined) out.subject = e.summary;
  if (e.description !== undefined) out.body = { contentType: "text", content: e.description };
  if (e.location !== undefined) out.location = { displayName: e.location };
  const start = graphTime(e.start, "start");
  const end = graphTime(e.end, "end");
  if (start !== undefined) out.start = start;
  if (end !== undefined) out.end = end;
  if (e.start?.date !== undefined) out.isAllDay = true;
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
      json: graphEventBody(event),
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
