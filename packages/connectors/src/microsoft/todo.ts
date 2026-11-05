import { type JsonObject, PsycheError } from "@psyche/protocol";
import { type GraphApi, GraphError } from "./api.ts";

/**
 * Microsoft To Do over Graph (`/me/todo/lists`, `/tasks`, delta queries), shaped like the Apple
 * Reminders adapter (`AppleReminder`, the Mac helper's and the Windows helper's `reminders.*`), so
 * the `reminders_*` tools, the daily brief, Memory → Work and search read To Do the same way.
 *
 * Mapping, where To Do and Reminders differ:
 * - a reminder id is `<listId>|<taskId>` (Graph addresses a task through its list);
 * - `due` is a date in To Do: it is kept as that day in the owner's time zone, the time of day is
 *   not (an `alarm` keeps a time);
 * - `priority` 1–4 is To Do's "Important" (importance high), 6–9 is low, 0 and 5 are normal; read
 *   back as 1, 9 or 0. `flagged` is the same star: a flagged reminder is an important task;
 * - `url` is the task's first linked resource; `alarm` is the task's reminder; `recurrence` is its
 *   patterned recurrence (To Do repeats need a due date, as Reminders' do).
 *
 * Trust (security §3.6): a list the owner owns and has not shared holds the owner's own tasks, so
 * its rows say `shared: false`; a shared list's rows say `shared: true`, and the "Flagged email"
 * list's rows (titles are other people's subjects) say `createdBy: "mail"`. Both stay untrusted.
 */

const TASK_PAGE = 100;
/** A safety stop per list: 40 pages of 100. */
const MAX_TASK_PAGES = 40;
const MAX_LIST_PAGES = 10;
const MAX_DELTA_PAGES = 20;
const SOURCE = "Microsoft To Do";

interface GraphList {
  id?: string;
  displayName?: string;
  isOwner?: boolean;
  isShared?: boolean;
  wellknownListName?: string;
}

interface DateTimeTz {
  dateTime?: string;
  timeZone?: string;
}

interface GraphRecurrence {
  pattern?: {
    type?: string;
    interval?: number;
    daysOfWeek?: string[];
    dayOfMonth?: number;
    month?: number;
  };
  range?: {
    type?: string;
    startDate?: string;
    endDate?: string;
    numberOfOccurrences?: number;
  };
}

interface GraphTask {
  id?: string;
  title?: string;
  body?: { content?: string; contentType?: string };
  importance?: string;
  status?: string;
  dueDateTime?: DateTimeTz | null;
  reminderDateTime?: DateTimeTz | null;
  isReminderOn?: boolean;
  recurrence?: GraphRecurrence | null;
  completedDateTime?: DateTimeTz | null;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  linkedResources?: { webUrl?: string; displayName?: string }[];
  "@removed"?: unknown;
}

/** `AppleAlarm`: a time, or minutes relative to the due date (negative: before). */
export type ReminderAlarm = { at: string } | { relativeMinutes: number };

/** `AppleRecurrence`. */
export interface ReminderRecurrence {
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval?: number;
  daysOfWeek?: string[];
  until?: string;
  count?: number;
}

export interface TodoListView {
  id: string;
  title: string;
  source: string;
  writable: boolean;
  shared: boolean;
  createdBy?: string;
  /** To Do's default list ("Tasks"), where a reminder goes without a listId. */
  default?: boolean;
}

/** `AppleReminder`, plus where it came from (`list`, `source`) and the trust attestation. */
export interface TodoReminderView {
  id: string;
  listId: string;
  list: string;
  title: string;
  notes: string | null;
  due: string | null;
  completed: boolean;
  priority: number;
  url: string | null;
  flagged: boolean;
  alarms?: { at: string }[];
  recurrence: ReminderRecurrence | null;
  shared: boolean;
  createdBy?: string;
  source: string;
  created?: string;
  modified?: string;
  completedAt?: string;
}

export interface ReminderFilter {
  listIds?: string[];
  completed?: boolean;
  dueBefore?: string;
  overdue?: boolean;
  dueToday?: boolean;
  flagged?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
}

export interface ReminderWrite {
  listId?: string;
  title?: string;
  notes?: string;
  /** null clears the due date. */
  due?: string | null;
  completed?: boolean;
  priority?: number;
  url?: string;
  alarm?: ReminderAlarm;
  recurrence?: ReminderRecurrence;
}

// --- time ------------------------------------------------------------------------------------

const UTC_NAMES = new Set(["utc", "etc/utc", "gmt", "z", "tzone://microsoft/utc"]);
const isUtc = (tz: string | undefined) => tz === undefined || UTC_NAMES.has(tz.toLowerCase());

/** Minutes east of UTC that `timeZone` is at the instant `at`; throws for an unknown zone. */
function offsetMinutes(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60_000);
}

/** A wall-clock `YYYY-MM-DDTHH:mm:ss` in `timeZone` as an instant (ms). */
export function wallToInstant(dateTime: string, timeZone: string | undefined): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(dateTime);
  if (m === null) return undefined;
  const wall = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
  );
  if (isUtc(timeZone)) return wall;
  try {
    // Twice: the offset at the guess, then at the corrected instant (DST edges).
    const first = wall - offsetMinutes(wall, timeZone as string) * 60_000;
    return wall - offsetMinutes(first, timeZone as string) * 60_000;
  } catch {
    // A Windows zone name Intl does not know: read it as this computer's local time.
    const local = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0));
    return local.getTime() + Number(m[5] ?? 0) * 60_000 + Number(m[6] ?? 0) * 1000;
  }
}

/** The calendar day (`YYYY-MM-DD`) of the instant `at` in `timeZone`. */
export function localDate(at: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(at));
    const v = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${v("year")}-${v("month")}-${v("day")}`;
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

const isoOf = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, "Z");

function instantOf(d: DateTimeTz | null | undefined): number | undefined {
  if (d === null || d === undefined || typeof d.dateTime !== "string") return undefined;
  return wallToInstant(d.dateTime, d.timeZone);
}

function parseIso(v: string, name: string): number {
  const t = Date.parse(v);
  if (Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}/.test(v)) {
    throw new PsycheError("invalid_params", `${name} is not an ISO date-time`);
  }
  return t;
}

// --- mapping ---------------------------------------------------------------------------------

const DAYS = {
  mo: "monday",
  tu: "tuesday",
  we: "wednesday",
  th: "thursday",
  fr: "friday",
  sa: "saturday",
  su: "sunday",
} as const;
const DAY_BY_NAME = new Map<string, string>(Object.entries(DAYS).map(([k, v]) => [v, k]));
const WEEKDAY = ["su", "mo", "tu", "we", "th", "fr", "sa"] as const;

function importanceOf(priority: number): string {
  if (priority >= 1 && priority <= 4) return "high";
  if (priority >= 6 && priority <= 9) return "low";
  return "normal";
}
const priorityOf = (importance: string | undefined) =>
  importance === "high" ? 1 : importance === "low" ? 9 : 0;

function recurrenceView(r: GraphRecurrence | null | undefined): ReminderRecurrence | null {
  const type = r?.pattern?.type;
  if (r === null || r === undefined || typeof type !== "string") return null;
  const frequency =
    type === "daily"
      ? "daily"
      : type === "weekly"
        ? "weekly"
        : type.endsWith("Monthly")
          ? "monthly"
          : type.endsWith("Yearly")
            ? "yearly"
            : undefined;
  if (frequency === undefined) return null;
  const out: ReminderRecurrence = { frequency };
  const interval = r.pattern?.interval;
  if (typeof interval === "number" && interval > 1) out.interval = interval;
  if (frequency === "weekly" && Array.isArray(r.pattern?.daysOfWeek)) {
    const days = r.pattern.daysOfWeek.flatMap((d) => DAY_BY_NAME.get(d.toLowerCase()) ?? []);
    if (days.length > 0) out.daysOfWeek = days;
  }
  if (r.range?.type === "endDate" && typeof r.range.endDate === "string")
    out.until = `${r.range.endDate.slice(0, 10)}T00:00:00Z`;
  if (r.range?.type === "numbered" && typeof r.range.numberOfOccurrences === "number")
    out.count = r.range.numberOfOccurrences;
  return out;
}

function recurrenceBody(r: ReminderRecurrence, dueDate: string, timeZone: string): JsonObject {
  const [y, m, d] = dueDate.split("-").map(Number) as [number, number, number];
  const interval = r.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 999) {
    throw new PsycheError("invalid_params", "recurrence.interval is 1–999");
  }
  const pattern: JsonObject = { interval, firstDayOfWeek: "sunday" };
  if (r.frequency === "daily") pattern.type = "daily";
  else if (r.frequency === "weekly") {
    pattern.type = "weekly";
    const days = (r.daysOfWeek ?? []).map((x) => {
      const day = DAYS[x as keyof typeof DAYS];
      if (day === undefined) throw new PsycheError("invalid_params", `not a weekday: ${x}`);
      return day;
    });
    pattern.daysOfWeek =
      days.length > 0 ? days : [DAYS[WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "mo"]];
  } else if (r.frequency === "monthly") {
    pattern.type = "absoluteMonthly";
    pattern.dayOfMonth = d;
  } else if (r.frequency === "yearly") {
    pattern.type = "absoluteYearly";
    pattern.dayOfMonth = d;
    pattern.month = m;
  } else {
    throw new PsycheError(
      "invalid_params",
      "recurrence.frequency is daily, weekly, monthly or yearly",
    );
  }
  const range: JsonObject = { startDate: dueDate, recurrenceTimeZone: timeZone };
  if (r.count !== undefined) {
    if (!Number.isInteger(r.count) || r.count < 1 || r.count > 999)
      throw new PsycheError("invalid_params", "recurrence.count is 1–999");
    range.type = "numbered";
    range.numberOfOccurrences = r.count;
  } else if (r.until !== undefined) {
    range.type = "endDate";
    range.endDate = localDate(parseIso(r.until, "recurrence.until"), timeZone);
  } else range.type = "noEnd";
  return { pattern, range };
}

/** `<listId>|<taskId>`: Graph ids are base64 and never hold `|`. */
export function reminderId(listId: string, taskId: string): string {
  return `${listId}|${taskId}`;
}

export function splitReminderId(id: unknown): { listId: string; taskId: string } {
  const s = typeof id === "string" ? id : "";
  const at = s.indexOf("|");
  if (at <= 0 || at === s.length - 1 || s.length > 2000) {
    throw new PsycheError("invalid_params", "id is not a Microsoft To Do reminder id", {
      details: { reason: "bad_id" },
    });
  }
  return { listId: s.slice(0, at), taskId: s.slice(at + 1) };
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

function listView(l: GraphList): TodoListView {
  const mail = l.wellknownListName === "flaggedEmails";
  const owned = l.isOwner !== false && l.isShared !== true;
  return {
    id: text(l.id, 500),
    title: text(l.displayName, 500),
    source: SOURCE,
    // "Flagged email" is filled by Outlook: tasks cannot be added to it.
    writable: !mail,
    shared: !owned,
    ...(mail ? { createdBy: "mail" } : {}),
    ...(l.wellknownListName === "defaultList" ? { default: true } : {}),
  };
}

export function reminderView(t: GraphTask, list: TodoListView): TodoReminderView {
  const due = instantOf(t.dueDateTime);
  const remindAt = t.isReminderOn === true ? instantOf(t.reminderDateTime) : undefined;
  const done = instantOf(t.completedDateTime);
  const body = t.body?.content;
  const notes =
    typeof body === "string" && body.trim() !== ""
      ? (t.body?.contentType === "html" ? body.replace(/<[^>]*>/g, " ") : body).slice(0, 10_000)
      : null;
  const url = (t.linkedResources ?? []).find((r) => typeof r.webUrl === "string")?.webUrl;
  const view: TodoReminderView = {
    id: reminderId(list.id, text(t.id, 1000)),
    listId: list.id,
    list: list.title,
    title: text(t.title, 1000),
    notes,
    due: due === undefined ? null : isoOf(due),
    completed: t.status === "completed",
    priority: priorityOf(t.importance),
    url: url === undefined ? null : url.slice(0, 2000),
    flagged: t.importance === "high",
    recurrence: recurrenceView(t.recurrence),
    shared: list.shared,
    source: SOURCE,
  };
  if (remindAt !== undefined) view.alarms = [{ at: isoOf(remindAt) }];
  if (list.createdBy !== undefined) view.createdBy = list.createdBy;
  if (typeof t.createdDateTime === "string") view.created = t.createdDateTime.slice(0, 40);
  if (typeof t.lastModifiedDateTime === "string")
    view.modified = t.lastModifiedDateTime.slice(0, 40);
  if (done !== undefined) view.completedAt = isoOf(done);
  return view;
}

/** Every row is the owner's own (attested `shared: false`, no other author). */
export function ownerOnlyTodo(rows: readonly { shared: boolean; createdBy?: string }[]): boolean {
  return rows.length > 0 && rows.every((r) => r.shared === false && r.createdBy === undefined);
}

// --- the client ------------------------------------------------------------------------------

export interface TodoOptions {
  /** The owner's IANA time zone (default: this computer's). Due dates are days in it. */
  timeZone?: () => string;
  now: () => number;
}

export class GraphTodo {
  readonly #api: GraphApi;
  readonly #opts: TodoOptions;

  constructor(api: GraphApi, opts: TodoOptions) {
    this.#api = api;
    this.#opts = opts;
  }

  #tz(): string {
    return this.#opts.timeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  }

  async lists(signal?: AbortSignal): Promise<TodoListView[]> {
    const out: TodoListView[] = [];
    let url: string | undefined = "/me/todo/lists";
    for (let page = 0; page < MAX_LIST_PAGES && url !== undefined; page++) {
      const r: { value?: GraphList[]; "@odata.nextLink"?: string } = await this.#api.json(url, {
        ...(page === 0 ? { query: { $top: 100 } } : {}),
        ...(signal === undefined ? {} : { signal }),
      });
      for (const l of r.value ?? []) if (typeof l.id === "string") out.push(listView(l));
      url = r["@odata.nextLink"];
    }
    return out;
  }

  async #list(listId: string, signal?: AbortSignal): Promise<TodoListView> {
    const l = (await this.lists(signal)).find((x) => x.id === listId);
    if (l === undefined) throw new PsycheError("not_found", "no such To Do list");
    return l;
  }

  async #tasks(
    list: TodoListView,
    completed: boolean | undefined,
    signal?: AbortSignal,
  ): Promise<TodoReminderView[]> {
    const out: TodoReminderView[] = [];
    let url: string | undefined = `/me/todo/lists/${encodeURIComponent(list.id)}/tasks`;
    const query: Record<string, string | number> = { $top: TASK_PAGE, $expand: "linkedResources" };
    if (completed !== undefined)
      query.$filter = completed ? "status eq 'completed'" : "status ne 'completed'";
    for (let page = 0; page < MAX_TASK_PAGES && url !== undefined; page++) {
      const r: { value?: GraphTask[]; "@odata.nextLink"?: string } = await this.#api.json(url, {
        ...(page === 0 ? { query } : {}),
        ...(signal === undefined ? {} : { signal }),
      });
      for (const t of r.value ?? []) {
        if (typeof t.id !== "string") continue;
        const v = reminderView(t, list);
        if (completed === undefined || v.completed === completed) out.push(v);
      }
      url = r["@odata.nextLink"];
    }
    return out;
  }

  /** `reminders.list`: soonest due first (no due date last), filtered, paged by offset. */
  async list(f: ReminderFilter, signal?: AbortSignal): Promise<{ reminders: TodoReminderView[] }> {
    const lists = await this.lists(signal);
    const wanted =
      f.listIds === undefined || f.listIds.length === 0
        ? lists
        : lists.filter((l) => f.listIds?.includes(l.id));
    // Overdue reminders are open ones.
    const completed = f.overdue === true ? false : f.completed;
    let rows: TodoReminderView[] = [];
    for (const l of wanted) rows.push(...(await this.#tasks(l, completed, signal)));
    const now = this.#opts.now();
    const tz = this.#tz();
    const today = wallToInstant(`${localDate(now, tz)}T00:00:00`, tz) ?? now;
    const tomorrow = wallToInstant(`${localDate(today + 36 * 3_600_000, tz)}T00:00:00`, tz) ?? now;
    const dueMs = (r: TodoReminderView) => (r.due === null ? undefined : Date.parse(r.due));
    if (f.dueBefore !== undefined) {
      const before = parseIso(f.dueBefore, "dueBefore");
      rows = rows.filter((r) => (dueMs(r) ?? Number.POSITIVE_INFINITY) <= before);
    }
    // To Do's due is a day: overdue is a day before today, as To Do itself shows it.
    if (f.overdue === true) rows = rows.filter((r) => (dueMs(r) ?? Infinity) < today);
    if (f.dueToday === true)
      rows = rows.filter((r) => {
        const d = dueMs(r);
        return d !== undefined && d >= today && d < tomorrow;
      });
    if (f.flagged === true) rows = rows.filter((r) => r.flagged);
    const q = f.query?.trim().toLowerCase();
    if (q !== undefined && q !== "")
      rows = rows.filter((r) => `${r.title}\n${r.notes ?? ""}`.toLowerCase().includes(q));
    rows.sort(
      (a, b) =>
        (dueMs(a) ?? Number.POSITIVE_INFINITY) - (dueMs(b) ?? Number.POSITIVE_INFINITY) ||
        a.title.localeCompare(b.title),
    );
    const offset = f.offset ?? 0;
    const limit = f.limit ?? 50;
    return { reminders: rows.slice(offset, offset + limit) };
  }

  /** The Graph task body for a write; `create` needs a title. */
  #body(w: ReminderWrite, create: boolean): JsonObject {
    const tz = this.#tz();
    const body: JsonObject = {};
    if (w.title !== undefined) {
      if (w.title.trim() === "") throw new PsycheError("invalid_params", "title is empty");
      body.title = w.title.slice(0, 500);
    } else if (create) throw new PsycheError("invalid_params", "title is required");
    if (w.notes !== undefined)
      body.body = { content: w.notes.slice(0, 10_000), contentType: "text" };
    let dueDay: string | undefined;
    if (w.due === null) body.dueDateTime = null;
    else if (w.due !== undefined) {
      dueDay = localDate(parseIso(w.due, "due"), tz);
      body.dueDateTime = { dateTime: `${dueDay}T00:00:00`, timeZone: tz };
    }
    if (w.completed !== undefined) body.status = w.completed ? "completed" : "notStarted";
    if (w.priority !== undefined) {
      if (!Number.isInteger(w.priority) || w.priority < 0 || w.priority > 9)
        throw new PsycheError("invalid_params", "priority is 0–9");
      body.importance = importanceOf(w.priority);
    }
    if (w.alarm !== undefined) {
      let at: number;
      if ("at" in w.alarm) at = parseIso(w.alarm.at, "alarm.at");
      else {
        if (dueDay === undefined)
          throw new PsycheError("invalid_params", "a relative alarm needs a due date");
        const mins = w.alarm.relativeMinutes;
        if (!Number.isInteger(mins) || mins > 0 || mins < -40_320)
          throw new PsycheError("invalid_params", "alarm.relativeMinutes is -40320–0");
        at = (wallToInstant(`${dueDay}T00:00:00`, tz) ?? 0) + mins * 60_000;
      }
      body.reminderDateTime = {
        dateTime: new Date(at).toISOString().replace(/Z$/, ""),
        timeZone: "UTC",
      };
      body.isReminderOn = true;
    }
    if (w.recurrence !== undefined) {
      if (dueDay === undefined)
        throw new PsycheError("invalid_params", "a repeating reminder needs a due date", {
          details: { field: "recurrence" },
        });
      body.recurrence = recurrenceBody(w.recurrence, dueDay, tz);
    }
    if (w.url !== undefined && w.url.trim() !== "") {
      body.linkedResources = [
        {
          webUrl: w.url.slice(0, 2000),
          applicationName: "Psyche",
          displayName: (w.title ?? "Link").slice(0, 200),
        },
      ];
    }
    return body;
  }

  /** The default list ("Tasks"), or the one named. "Flagged email" takes no new tasks. */
  async #target(listId: string | undefined, signal?: AbortSignal): Promise<TodoListView> {
    const lists = await this.lists(signal);
    const l =
      listId === undefined
        ? (lists.find((x) => x.default === true) ??
          lists.find((x) => x.writable && !x.shared) ??
          lists.find((x) => x.writable))
        : lists.find((x) => x.id === listId);
    if (l === undefined) throw new PsycheError("not_found", "no such To Do list");
    if (!l.writable) throw new PsycheError("invalid_params", `${l.title} does not take new tasks`);
    return l;
  }

  async create(w: ReminderWrite, signal?: AbortSignal): Promise<TodoReminderView> {
    const body = this.#body(w, true);
    const list = await this.#target(w.listId, signal);
    const t = await this.#api.json<GraphTask>(
      `/me/todo/lists/${encodeURIComponent(list.id)}/tasks`,
      { method: "POST", json: body, ...(signal === undefined ? {} : { signal }) },
    );
    return reminderView(t, list);
  }

  async update(id: string, w: ReminderWrite, signal?: AbortSignal): Promise<TodoReminderView> {
    const { listId, taskId } = splitReminderId(id);
    const body = this.#body(w, false);
    const list = await this.#list(listId, signal);
    const t = await this.#api.json<GraphTask>(
      `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
      { method: "PATCH", json: body, ...(signal === undefined ? {} : { signal }) },
    );
    return reminderView(t, list);
  }

  /** By id, or by the exact title of one open (or, to reopen, one done) reminder. */
  async complete(
    input: { id?: string; title?: string; listId?: string; completed?: boolean },
    signal?: AbortSignal,
  ): Promise<TodoReminderView> {
    const completed = input.completed ?? true;
    let id = input.id;
    if (id === undefined) {
      const title = input.title?.trim().toLowerCase() ?? "";
      if (title === "") throw new PsycheError("invalid_params", "give id or title");
      const { reminders } = await this.list(
        {
          completed: !completed,
          ...(input.listId === undefined ? {} : { listIds: [input.listId] }),
          limit: 100_000,
        },
        signal,
      );
      const hits = reminders.filter((r) => r.title.trim().toLowerCase() === title);
      if (hits.length === 0)
        throw new PsycheError("not_found", "no reminder has that title", {
          details: { reason: "not_found" },
        });
      if (hits.length > 1)
        throw new PsycheError("invalid_params", "several reminders have that title: give the id", {
          details: { reason: "ambiguous", ids: hits.slice(0, 10).map((h) => h.id) },
        });
      id = (hits[0] as TodoReminderView).id;
    }
    return this.update(id, { completed }, signal);
  }

  async setFlagged(id: string, flagged: boolean, signal?: AbortSignal): Promise<TodoReminderView> {
    const { listId, taskId } = splitReminderId(id);
    const list = await this.#list(listId, signal);
    const t = await this.#api.json<GraphTask>(
      `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
      {
        method: "PATCH",
        json: { importance: flagged ? "high" : "normal" },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return reminderView(t, list);
  }

  async delete(id: string, signal?: AbortSignal): Promise<void> {
    const { listId, taskId } = splitReminderId(id);
    await this.#api.request(
      `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
      { method: "DELETE", ...(signal === undefined ? {} : { signal }) },
    );
  }

  /**
   * Per-list `tasks/delta`: the first pass of a list is full (nothing counted), later ones count
   * the tasks that changed. A lost token (410 / syncStateNotFound) restarts that list; a list
   * that is gone drops out of the cursor.
   */
  async sync(
    cursor: Record<string, string> | undefined,
    signal?: AbortSignal,
  ): Promise<{ cursor: Record<string, string>; changed: number; full: boolean }> {
    const prev = cursor ?? {};
    const next: Record<string, string> = {};
    let changed = 0;
    let full = false;
    for (const l of await this.lists(signal)) {
      const start = `/me/todo/lists/${encodeURIComponent(l.id)}/tasks/delta`;
      let fresh = prev[l.id] === undefined;
      let url = prev[l.id] ?? start;
      for (let i = 0; i < MAX_DELTA_PAGES; i++) {
        let page: { value?: GraphTask[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };
        try {
          page = await this.#api.json(url, signal === undefined ? {} : { signal });
        } catch (err) {
          if (
            err instanceof GraphError &&
            (err.status === 410 || err.graphCode === "syncStateNotFound") &&
            !fresh
          ) {
            fresh = true;
            url = start;
            continue;
          }
          throw err;
        }
        if (!fresh) changed += (page.value ?? []).length;
        const delta = page["@odata.deltaLink"];
        if (typeof delta === "string") {
          this.#api.url(delta);
          next[l.id] = delta;
          break;
        }
        const more = page["@odata.nextLink"];
        if (typeof more !== "string") break;
        this.#api.url(more);
        url = more;
      }
      full ||= fresh;
    }
    return { cursor: next, changed, full };
  }
}
