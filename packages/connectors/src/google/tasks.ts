import { PsycheError } from "@psyche/protocol";
import type { GoogleApi } from "./api.ts";

/**
 * Google Tasks over REST (`tasks.googleapis.com/tasks/v1`): task lists and the tasks in them,
 * shaped like the To Do client (`microsoft/todo.ts`) so the `reminders_*` tools read Google Tasks
 * the same way they read To Do. Filters run here over every page of a list (bounded), because
 * Google's own `dueMin`/`dueMax` filters cover only some of them.
 *
 * Mapping, where Google Tasks and To Do differ:
 * - a reminder id is `<listId>|<taskId>`, as for To Do;
 * - `due` is a day: Google stores it as UTC midnight of that day, so the day is read from the
 *   date part and written as `YYYY-MM-DDT00:00:00.000Z`;
 * - Google Tasks has no priority, Important flag, link, alarm or repeat: the tools refuse those
 *   fields rather than store them somewhere else.
 *
 * Trust: Google Tasks lists cannot be shared through the API, so every list is the owner's own
 * (`shared: false`) and its rows are owner content.
 */

export const TASKS_BASE = "https://tasks.googleapis.com/tasks/v1";
const PAGE = 100;
/** Safety stops: 40 pages of 100 tasks per list, 10 pages of lists. */
const MAX_TASK_PAGES = 40;
const MAX_LIST_PAGES = 10;
const SOURCE = "Google Tasks";

interface GoogleTaskList {
  id?: string;
  title?: string;
}

interface GoogleTask {
  id?: string;
  title?: string;
  notes?: string;
  status?: string;
  due?: string;
  completed?: string;
  updated?: string;
}

export interface TaskListView {
  id: string;
  title: string;
  source: string;
  writable: boolean;
  shared: boolean;
}

/** The To Do reminder view, with the fields Google Tasks has (the rest are fixed). */
export interface TaskReminderView {
  id: string;
  listId: string;
  list: string;
  title: string;
  notes: string | null;
  /** The due day as Google stores it (`YYYY-MM-DDT00:00:00.000Z`), or null. */
  due: string | null;
  completed: boolean;
  priority: 0;
  url: null;
  flagged: false;
  recurrence: null;
  shared: false;
  source: string;
  modified?: string;
  completedAt?: string;
}

export interface TaskFilter {
  listIds?: string[];
  completed?: boolean;
  dueBefore?: string;
  overdue?: boolean;
  dueToday?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
}

export interface TaskWrite {
  title?: string;
  notes?: string;
  /** An instant: its day in the owner's time zone is the due day. */
  due?: string;
  completed?: boolean;
}

export interface TasksOptions {
  /** The owner's IANA time zone (default: this computer's). Due dates are days in it. */
  timeZone?: () => string;
  now: () => number;
}

/** The calendar day (`YYYY-MM-DD`) of the instant `at` in `timeZone`. */
export function dayIn(at: number, timeZone: string): string {
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

function parseInstant(v: string, name: string): number {
  const t = Date.parse(v);
  if (Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}/.test(v)) {
    throw new PsycheError("invalid_params", `${name} is not an ISO date-time`);
  }
  return t;
}

/** `<listId>|<taskId>`; both halves are required. */
export function splitTaskId(id: string): { listId: string; taskId: string } {
  const at = id.indexOf("|");
  if (at <= 0 || at === id.length - 1) {
    throw new PsycheError("invalid_params", "id is <listId>|<taskId> from a reminders_list result");
  }
  return { listId: id.slice(0, at), taskId: id.slice(at + 1) };
}

function listView(l: GoogleTaskList & { id: string }): TaskListView {
  return {
    id: l.id,
    title: typeof l.title === "string" ? l.title : "",
    source: SOURCE,
    writable: true,
    shared: false,
  };
}

function reminderView(t: GoogleTask, list: TaskListView): TaskReminderView {
  const due = typeof t.due === "string" && t.due !== "" ? t.due : null;
  const completed = t.status === "completed";
  const notes = typeof t.notes === "string" && t.notes !== "" ? t.notes : null;
  const out: TaskReminderView = {
    id: `${list.id}|${t.id ?? ""}`,
    listId: list.id,
    list: list.title,
    title: typeof t.title === "string" ? t.title : "",
    notes,
    due,
    completed,
    priority: 0,
    url: null,
    flagged: false,
    recurrence: null,
    shared: false,
    source: SOURCE,
  };
  if (typeof t.updated === "string") out.modified = t.updated;
  if (completed && typeof t.completed === "string") out.completedAt = t.completed;
  return out;
}

export class GoogleTasks {
  readonly #api: GoogleApi;
  readonly #opts: TasksOptions;

  constructor(api: GoogleApi, opts: TasksOptions) {
    this.#api = api;
    this.#opts = opts;
  }

  #tz(): string {
    return this.#opts.timeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  }

  async lists(signal?: AbortSignal): Promise<TaskListView[]> {
    const out: TaskListView[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const r: { items?: (GoogleTaskList & { id?: string })[]; nextPageToken?: string } =
        await this.#api.json(`${TASKS_BASE}/users/@me/lists`, {
          query: { maxResults: PAGE, pageToken },
          ...(signal === undefined ? {} : { signal }),
        });
      for (const l of r.items ?? [])
        if (typeof l.id === "string") out.push(listView({ ...l, id: l.id }));
      pageToken = r.nextPageToken;
      if (pageToken === undefined) break;
    }
    return out;
  }

  async #list(listId: string, signal?: AbortSignal): Promise<TaskListView> {
    const all = await this.lists(signal);
    const l = all.find((x) => x.id === listId);
    if (l === undefined) throw new PsycheError("not_found", "no such Google task list");
    return l;
  }

  async #tasks(
    list: TaskListView,
    completed: boolean | undefined,
    signal?: AbortSignal,
  ): Promise<TaskReminderView[]> {
    const out: TaskReminderView[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_TASK_PAGES; page++) {
      const r: { items?: GoogleTask[]; nextPageToken?: string } = await this.#api.json(
        `${TASKS_BASE}/lists/${encodeURIComponent(list.id)}/tasks`,
        {
          query: {
            maxResults: PAGE,
            pageToken,
            // Completed tasks come back unless the owner asked for open ones only.
            showCompleted: completed !== false,
            showHidden: false,
          },
          ...(signal === undefined ? {} : { signal }),
        },
      );
      for (const t of r.items ?? []) {
        if (typeof t.id !== "string") continue;
        const v = reminderView(t, list);
        if (completed === undefined || v.completed === completed) out.push(v);
      }
      pageToken = r.nextPageToken;
      if (pageToken === undefined) break;
    }
    return out;
  }

  /** `reminders.list`: soonest due first (no due date last), filtered, paged by offset. */
  async list(f: TaskFilter, signal?: AbortSignal): Promise<{ reminders: TaskReminderView[] }> {
    const lists = await this.lists(signal);
    const wanted =
      f.listIds === undefined || f.listIds.length === 0
        ? lists
        : lists.filter((l) => f.listIds?.includes(l.id));
    // Overdue tasks are open ones.
    const completed = f.overdue === true ? false : f.completed;
    let rows: TaskReminderView[] = [];
    for (const l of wanted) rows.push(...(await this.#tasks(l, completed, signal)));
    const tz = this.#tz();
    const today = dayIn(this.#opts.now(), tz);
    // A due day compares as a day: `YYYY-MM-DD` strings order the same way the days do.
    const dayOf = (r: TaskReminderView) => (r.due === null ? undefined : r.due.slice(0, 10));
    if (f.dueBefore !== undefined) {
      const before = dayIn(parseInstant(f.dueBefore, "dueBefore"), tz);
      rows = rows.filter((r) => (dayOf(r) ?? "9999-12-31") <= before);
    }
    if (f.overdue === true) rows = rows.filter((r) => (dayOf(r) ?? "9999-12-31") < today);
    if (f.dueToday === true) rows = rows.filter((r) => dayOf(r) === today);
    const q = f.query?.trim().toLowerCase();
    if (q !== undefined && q !== "")
      rows = rows.filter((r) => `${r.title}\n${r.notes ?? ""}`.toLowerCase().includes(q));
    rows.sort(
      (a, b) =>
        (dayOf(a) ?? "9999-12-31").localeCompare(dayOf(b) ?? "9999-12-31") ||
        a.title.localeCompare(b.title),
    );
    const offset = f.offset ?? 0;
    const limit = f.limit ?? 50;
    return { reminders: rows.slice(offset, offset + limit) };
  }

  /** The Google task body for a write. `create` needs a title. */
  #body(w: TaskWrite, create: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (w.title !== undefined) {
      if (w.title.trim() === "") throw new PsycheError("invalid_params", "title is empty");
      body.title = w.title.slice(0, 500);
    } else if (create) throw new PsycheError("invalid_params", "title is required");
    if (w.notes !== undefined) body.notes = w.notes.slice(0, 10_000);
    if (w.due !== undefined) {
      const day = dayIn(parseInstant(w.due, "due"), this.#tz());
      body.due = `${day}T00:00:00.000Z`;
    }
    if (w.completed !== undefined) body.status = w.completed ? "completed" : "needsAction";
    return body;
  }

  /** The list a new task goes to: the one named, or Google's default (the first list). */
  async #target(listId: string | undefined, signal?: AbortSignal): Promise<TaskListView> {
    const lists = await this.lists(signal);
    const l = listId === undefined ? lists[0] : lists.find((x) => x.id === listId);
    if (l === undefined) throw new PsycheError("not_found", "no such Google task list");
    return l;
  }

  async create(
    w: TaskWrite & { listId?: string },
    signal?: AbortSignal,
  ): Promise<TaskReminderView> {
    const body = this.#body(w, true);
    const list = await this.#target(w.listId, signal);
    const t = await this.#api.json<GoogleTask>(
      `${TASKS_BASE}/lists/${encodeURIComponent(list.id)}/tasks`,
      { method: "POST", json: body, ...(signal === undefined ? {} : { signal }) },
    );
    return reminderView(t, list);
  }

  async update(id: string, w: TaskWrite, signal?: AbortSignal): Promise<TaskReminderView> {
    const { listId, taskId } = splitTaskId(id);
    const body = this.#body(w, false);
    const list = await this.#list(listId, signal);
    const t = await this.#api.json<GoogleTask>(
      `${TASKS_BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
      { method: "PATCH", json: body, ...(signal === undefined ? {} : { signal }) },
    );
    return reminderView(t, list);
  }

  /** By id, or by the exact title of one open (or, to reopen, one done) task. */
  async complete(
    input: { id?: string; title?: string; listId?: string; completed?: boolean },
    signal?: AbortSignal,
  ): Promise<TaskReminderView> {
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
        throw new PsycheError("not_found", "no task has that title", {
          details: { reason: "not_found" },
        });
      if (hits.length > 1)
        throw new PsycheError("invalid_params", "several tasks have that title: give the id", {
          details: { reason: "ambiguous", ids: hits.slice(0, 10).map((h) => h.id) },
        });
      id = (hits[0] as TaskReminderView).id;
    }
    return this.update(id, { completed }, signal);
  }

  async delete(id: string, signal?: AbortSignal): Promise<void> {
    const { listId, taskId } = splitTaskId(id);
    await this.#api.json(
      `${TASKS_BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
      { method: "DELETE", ...(signal === undefined ? {} : { signal }) },
    );
  }
}
