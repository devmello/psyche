import { PsycheError } from "@psyche/protocol";
import { type GoogleApi, statusOf } from "./api.ts";

/**
 * Calendar API v3 (research KQ4). Event listings must be bounded (`timeMin` / `timeMax`, at most
 * `MAX_RANGE_DAYS`). Incremental sync stores `nextSyncToken`; HTTP 410 means the token expired:
 * drop it and run a full sync.
 */
export const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
export const MAX_RANGE_DAYS = 366;
export const MAX_EVENTS = 250;

export interface EventInput {
  summary?: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: { email: string; optional?: boolean }[];
  recurrence?: string[];
  reminders?: { useDefault: boolean; overrides?: { method: "email" | "popup"; minutes: number }[] };
}

export interface EventView {
  id: string;
  status: string;
  summary: string;
  description: string;
  location: string;
  start: unknown;
  end: unknown;
  organizer: string;
  attendees: { email: string; responseStatus: string }[];
  htmlLink: string;
  updated: string;
}

interface RawEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: unknown;
  end?: unknown;
  organizer?: { email?: string };
  attendees?: { email?: string; responseStatus?: string }[];
  htmlLink?: string;
  updated?: string;
}

const s = (v: unknown, max = 5000) => (typeof v === "string" ? v.slice(0, max) : "");

export function eventView(e: RawEvent): EventView {
  return {
    id: s(e.id),
    status: s(e.status),
    summary: s(e.summary, 500),
    description: s(e.description),
    location: s(e.location, 500),
    start: e.start ?? null,
    end: e.end ?? null,
    organizer: s(e.organizer?.email),
    attendees: (e.attendees ?? [])
      .slice(0, 200)
      .map((a) => ({ email: s(a.email), responseStatus: s(a.responseStatus) })),
    htmlLink: s(e.htmlLink),
    updated: s(e.updated),
  };
}

function boundedRange(timeMin: string, timeMax: string): void {
  const a = Date.parse(timeMin);
  const b = Date.parse(timeMax);
  if (!Number.isFinite(a) || !Number.isFinite(b))
    throw new PsycheError("invalid_params", "timeMin and timeMax must be RFC 3339");
  if (b <= a) throw new PsycheError("invalid_params", "timeMax must be after timeMin");
  if (b - a > MAX_RANGE_DAYS * 86_400_000) {
    throw new PsycheError("invalid_params", `ranges are limited to ${MAX_RANGE_DAYS} days`);
  }
}

export function assertEventInput(e: EventInput): void {
  const ok = (t: EventInput["start"]) =>
    (typeof t?.dateTime === "string" && Number.isFinite(Date.parse(t.dateTime))) ||
    (typeof t?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.date));
  if (!ok(e.start) || !ok(e.end))
    throw new PsycheError("invalid_params", "start and end need dateTime or date");
  if ((e.attendees ?? []).length > 100)
    throw new PsycheError("invalid_params", "too many attendees");
}

const cal = (id: string) => `${CALENDAR_BASE}/calendars/${encodeURIComponent(id)}`;

export class Calendar {
  readonly #api: GoogleApi;

  constructor(api: GoogleApi) {
    this.#api = api;
  }

  async listCalendars(signal?: AbortSignal) {
    const r = await this.#api.json<{
      items?: {
        id?: string;
        summary?: string;
        primary?: boolean;
        accessRole?: string;
        timeZone?: string;
      }[];
    }>(`${CALENDAR_BASE}/users/me/calendarList`, {
      query: { maxResults: 250 },
      ...(signal === undefined ? {} : { signal }),
    });
    return (r.items ?? []).map((c) => ({
      id: s(c.id),
      summary: s(c.summary, 500),
      primary: c.primary === true,
      accessRole: s(c.accessRole),
      timeZone: s(c.timeZone),
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
  ): Promise<EventView[]> {
    boundedRange(input.timeMin, input.timeMax);
    const r = await this.#api.json<{ items?: RawEvent[] }>(
      `${cal(input.calendarId ?? "primary")}/events`,
      {
        query: {
          timeMin: input.timeMin,
          timeMax: input.timeMax,
          q: input.query,
          singleEvents: true,
          orderBy: "startTime",
          maxResults: Math.min(Math.max(input.maxResults ?? 50, 1), MAX_EVENTS),
        },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return (r.items ?? []).map(eventView);
  }

  async freeBusy(
    input: { timeMin: string; timeMax: string; calendarIds: string[]; timeZone?: string },
    signal?: AbortSignal,
  ) {
    boundedRange(input.timeMin, input.timeMax);
    if (input.calendarIds.length === 0 || input.calendarIds.length > 50) {
      throw new PsycheError("invalid_params", "1 to 50 calendars");
    }
    const r = await this.#api.json<{
      calendars?: Record<string, { busy?: { start?: string; end?: string }[]; errors?: unknown[] }>;
    }>(`${CALENDAR_BASE}/freeBusy`, {
      method: "POST",
      json: {
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
        items: input.calendarIds.map((id) => ({ id })),
      },
      ...(signal === undefined ? {} : { signal }),
    });
    return Object.fromEntries(
      Object.entries(r.calendars ?? {}).map(([id, v]) => [
        id,
        {
          busy: (v.busy ?? []).map((b) => ({ start: s(b.start), end: s(b.end) })),
          error: (v.errors ?? []).length > 0,
        },
      ]),
    );
  }

  async createEvent(
    calendarId: string,
    event: EventInput,
    sendUpdates: "all" | "none",
    signal?: AbortSignal,
  ) {
    assertEventInput(event);
    const r = await this.#api.json<RawEvent>(`${cal(calendarId)}/events`, {
      method: "POST",
      query: { sendUpdates },
      json: event,
      ...(signal === undefined ? {} : { signal }),
    });
    return eventView(r);
  }

  async updateEvent(
    calendarId: string,
    eventId: string,
    patch: Partial<EventInput>,
    sendUpdates: "all" | "none",
    signal?: AbortSignal,
  ) {
    if (patch.start !== undefined || patch.end !== undefined) {
      assertEventInput({
        start: patch.start ?? { date: "2000-01-01" },
        end: patch.end ?? { date: "2000-01-02" },
      });
    }
    const r = await this.#api.json<RawEvent>(
      `${cal(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: "PATCH",
        query: { sendUpdates },
        json: patch,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return eventView(r);
  }

  async deleteEvent(
    calendarId: string,
    eventId: string,
    sendUpdates: "all" | "none",
    signal?: AbortSignal,
  ) {
    await this.#api.json(`${cal(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
      query: { sendUpdates },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /**
   * Incremental sync of one calendar. With no token (or after a 410) a full sync walks all pages
   * and returns the new `nextSyncToken`. Deleted events arrive with `status: "cancelled"`.
   */
  async sync(
    calendarId: string,
    syncToken: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ syncToken: string; changed: EventView[]; full: boolean }> {
    try {
      return await this.#walk(calendarId, syncToken, signal);
    } catch (err) {
      if (syncToken !== undefined && statusOf(err) === 410)
        return this.#walk(calendarId, undefined, signal);
      throw err;
    }
  }

  async #walk(calendarId: string, syncToken: string | undefined, signal?: AbortSignal) {
    const changed: EventView[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 40; page++) {
      const r = await this.#api.json<{
        items?: RawEvent[];
        nextPageToken?: string;
        nextSyncToken?: string;
      }>(`${cal(calendarId)}/events`, {
        // Sync tokens are incompatible with most filters (Google returns 400), so none are sent.
        query: {
          syncToken,
          pageToken,
          maxResults: MAX_EVENTS,
          showDeleted: syncToken === undefined ? undefined : true,
        },
        ...(signal === undefined ? {} : { signal }),
      });
      changed.push(...(r.items ?? []).map(eventView));
      if (r.nextPageToken !== undefined) {
        pageToken = r.nextPageToken;
        continue;
      }
      if (r.nextSyncToken === undefined)
        throw new PsycheError("internal", "Calendar returned no nextSyncToken");
      return { syncToken: r.nextSyncToken, changed, full: syncToken === undefined };
    }
    throw new PsycheError("internal", "calendar sync did not finish within the page limit");
  }
}
