import type { FakeGoogle } from "./fake-google.ts";

/** Google Tasks REST, in memory, on a FakeGoogle's route table (`tasks.googleapis.com/tasks/v1`). */
export interface FakeTask {
  id: string;
  title: string;
  notes?: string;
  status: "needsAction" | "completed";
  /** UTC midnight of the due day, as Google stores it. */
  due?: string;
  completed?: string;
  updated: string;
}

export interface FakeTaskList {
  id: string;
  title: string;
  tasks: FakeTask[];
}

export interface FakeWrite {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const notFound = () => json({ error: { code: 404, errors: [{ reason: "notFound" }] } }, 404);

/**
 * Installs the Tasks routes for `lists` on `g`. Lists page their tasks `pageSize` at a time (the
 * client must follow `nextPageToken`). Writes are recorded in `writes`, and the list / task
 * queries (with their `showCompleted`) in `queries`.
 */
export class FakeTasksApi {
  readonly writes: FakeWrite[] = [];
  readonly queries: Record<string, string>[] = [];
  readonly #lists: FakeTaskList[];
  readonly #registered = new Set<string>();
  #seq = 0;

  constructor(
    readonly g: FakeGoogle,
    lists: FakeTaskList[],
    readonly pageSize = 2,
  ) {
    this.#lists = lists;
    g.route("GET", "/tasks/v1/users/@me/lists", () =>
      json({
        kind: "tasks#taskLists",
        items: this.#lists.map((l) => ({
          id: l.id,
          title: l.title,
          updated: "2026-10-18T00:00:00Z",
        })),
      }),
    );
    for (const l of lists) {
      this.#registerList(l.id);
      for (const t of l.tasks) this.#registerTask(l.id, t.id);
    }
  }

  get lists(): FakeTaskList[] {
    return this.#lists;
  }

  #list(id: string): FakeTaskList | undefined {
    return this.#lists.find((l) => l.id === id);
  }

  #registerList(listId: string): void {
    const base = `/tasks/v1/lists/${listId}/tasks`;
    if (this.#registered.has(base)) return;
    this.#registered.add(base);
    this.g.route("GET", base, ({ url }: { url: URL }) => {
      const list = this.#list(listId);
      if (list === undefined) return notFound();
      const q = Object.fromEntries(url.searchParams);
      this.queries.push(q);
      let items = list.tasks;
      if (q.showCompleted === "false") items = items.filter((t) => t.status !== "completed");
      const start = Number(q.pageToken ?? 0);
      const page = items.slice(start, start + this.pageSize);
      const more = start + this.pageSize < items.length;
      return json({
        kind: "tasks#tasks",
        items: page.map((t) => ({ ...t, kind: "tasks#task" })),
        ...(more ? { nextPageToken: String(start + this.pageSize) } : {}),
      });
    });
    this.g.route("POST", base, async ({ body }: { body: string }) => {
      const list = this.#list(listId);
      if (list === undefined) return notFound();
      const b = JSON.parse(body) as Record<string, unknown>;
      this.writes.push({ method: "POST", path: base, body: b });
      const task: FakeTask = {
        id: `new-${++this.#seq}`,
        title: typeof b.title === "string" ? b.title : "",
        status: b.status === "completed" ? "completed" : "needsAction",
        updated: "2026-10-18T20:00:00.000Z",
        ...(typeof b.notes === "string" ? { notes: b.notes } : {}),
        ...(typeof b.due === "string" ? { due: b.due } : {}),
      };
      list.tasks.push(task);
      this.#registerTask(listId, task.id);
      return json(task);
    });
  }

  #registerTask(listId: string, taskId: string): void {
    const path = `/tasks/v1/lists/${listId}/tasks/${taskId}`;
    if (this.#registered.has(path)) return;
    this.#registered.add(path);
    this.g.route("PATCH", path, async ({ body }: { body: string }) => {
      const task = this.#list(listId)?.tasks.find((t) => t.id === taskId);
      if (task === undefined) return notFound();
      const b = JSON.parse(body) as Record<string, unknown>;
      this.writes.push({ method: "PATCH", path, body: b });
      if (typeof b.title === "string") task.title = b.title;
      if (typeof b.notes === "string") task.notes = b.notes;
      if (typeof b.due === "string") task.due = b.due;
      if (b.status === "completed") {
        task.status = "completed";
        task.completed = "2026-10-18T20:00:00.000Z";
      } else if (b.status === "needsAction") {
        task.status = "needsAction";
        delete task.completed;
      }
      task.updated = "2026-10-18T20:00:00.000Z";
      return json(task);
    });
    this.g.route("DELETE", path, () => {
      const list = this.#list(listId);
      if (list === undefined) return notFound();
      const at = list.tasks.findIndex((t) => t.id === taskId);
      if (at < 0) return notFound();
      this.writes.push({ method: "DELETE", path, body: {} });
      list.tasks.splice(at, 1);
      return new Response(null, { status: 204 });
    });
  }
}
