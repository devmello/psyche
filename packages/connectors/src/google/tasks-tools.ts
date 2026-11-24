import { PsycheError } from "@psyche/protocol";
import { asObject, optString } from "../framework/params.ts";
import type { ConnectorAction, ConnectorTool, ToolOutput } from "../framework/types.ts";
import { actionBinding } from "../mail/binding.ts";
import { GOOGLE_SCOPES, GoogleAuthError } from "./auth.ts";
import type { GoogleTasks, TaskReminderView, TaskWrite } from "./tasks.ts";

/**
 * The `reminders_*` tools over Google Tasks: the same names, schemas, matrix rows and outputs as
 * Microsoft To Do (`microsoft/todo-tools.ts`, `TODO_ACTIONS`), so the agent sees one task tool
 * set whichever account holds the tasks. Google Tasks has no priority, Important flag, link,
 * alarm or repeat, so those inputs are refused with a message instead of being dropped.
 */

export const TASKS_ACTIONS: ConnectorAction[] = [
  { id: "reminders.read", title: "Read reminders", sideEffect: "read", defaultRule: "allow" },
  {
    id: "reminders.write",
    title: "Add, change, complete and flag reminders",
    sideEffect: "write",
    approvalKind: "connector_action",
    defaultRule: "ask",
  },
  {
    id: "reminders.delete",
    title: "Delete reminders",
    sideEffect: "destructive",
    approvalKind: "connector_action",
    defaultRule: "ask",
  },
];

/** What the granted scopes allow: reading Google Tasks, and changing it. */
export interface TasksAccess {
  read: boolean;
  write: boolean;
}

export function tasksAccess(scopes: readonly string[]): TasksAccess {
  const s = new Set(scopes);
  return {
    read: s.has(GOOGLE_SCOPES.tasks) || s.has(GOOGLE_SCOPES.tasksReadonly),
    write: s.has(GOOGLE_SCOPES.tasks),
  };
}

/**
 * A connection made before Google Tasks was added (or a read-only one, for a change) has no
 * Tasks scope: the tool says so, and the owner reconnects Google to grant it.
 */
function needScope(access: TasksAccess, kind: "read" | "write"): void {
  if (kind === "read" && access.read) return;
  if (kind === "write" && access.write) return;
  const msg =
    kind === "write" && access.read
      ? "Google did not grant: tasks (changing tasks needs read and act). Reconnect Google to change Google Tasks"
      : "Google did not grant: tasks. Reconnect Google so Psyche can use Google Tasks";
  throw new GoogleAuthError("missing_scopes", msg);
}

const iso = { type: "string", format: "date-time" };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const refused = (field: string, why: string): never => {
  throw new PsycheError("invalid_params", `${field} is not supported on Google Tasks: ${why}`, {
    details: { field },
  });
};
const bool = (v: unknown, name: string): boolean | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new PsycheError("invalid_params", `${name} must be a boolean`);
  return v;
};
const int = (v: unknown, name: string, min: number, max: number): number | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    throw new PsycheError("invalid_params", `${name} must be an integer ${min}–${max}`);
  return v;
};
const textParam = (v: unknown, name: string, max: number): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length > max)
    throw new PsycheError("invalid_params", `${name} must be text of at most ${max} characters`);
  return v;
};

/** The fields Google Tasks cannot hold: a refusal, never a silent drop. */
function refuseUnsupported(o: Record<string, unknown>, fields: string[]): void {
  const why: Record<string, string> = {
    priority: "it has no importance levels",
    url: "a task cannot link to a page",
    alarm: "it has no reminders",
    recurrence: "it does not repeat",
    flagged: "it has no Important flag",
  };
  for (const f of fields) if (o[f] !== undefined) refused(f, why[f] ?? "it is not stored");
}

function writeOf(o: Record<string, unknown>): TaskWrite & { listId?: string } {
  const w: TaskWrite & { listId?: string } = {};
  const listId = optString(o.listId);
  if (listId !== undefined) w.listId = listId;
  const title = textParam(o.title, "title", 500);
  if (title !== undefined) w.title = title;
  const notes = textParam(o.notes, "notes", 10_000);
  if (notes !== undefined) w.notes = notes;
  if (o.due === null) refused("due null", "Psyche cannot clear a due date here; set a new one");
  const due = optString(o.due);
  if (due !== undefined) w.due = due;
  const completed = bool(o.completed, "completed");
  if (completed !== undefined) w.completed = completed;
  return w;
}

/** Owner content: Google Tasks lists are not shared through the API (see `tasks.ts`). */
const out = (output: unknown, extra: Partial<ToolOutput> = {}): ToolOutput => ({
  output,
  provenance: "trusted",
  ...extra,
});

const LABEL = "Google Tasks";
const short = (s: string) => (s.length > 60 ? `${s.slice(0, 59)}…` : s);

export function tasksTools(deps: {
  connectorId: string;
  tasks: GoogleTasks;
  access: () => TasksAccess;
  guard: <T>(fn: () => Promise<T>) => Promise<T>;
}): ConnectorTool[] {
  const { tasks, guard } = deps;
  const bind = (name: string) => (p: unknown) => actionBinding(deps.connectorId, name, p);
  const reading = (fn: () => Promise<ToolOutput>) =>
    guard(async () => {
      needScope(deps.access(), "read");
      return fn();
    });
  const writing = (fn: () => Promise<ToolOutput>) =>
    guard(async () => {
      needScope(deps.access(), "write");
      return fn();
    });
  const written = (r: TaskReminderView, verb: string) =>
    out(
      { reminder: r },
      {
        externalRefs: { reminderId: r.id },
        receiptSummary: `${LABEL}: ${verb} "${short(r.title)}"`,
      },
    );
  return [
    {
      name: "reminders_list_lists",
      action: "reminders.read",
      description: "List the Google Tasks lists (id, title, writable, shared).",
      inputSchema: obj({}),
      sideEffect: "read",
      execute: (_p, run) =>
        reading(async () => {
          const lists = await tasks.lists(run.signal);
          return out({ lists });
        }),
    },
    {
      name: "reminders_list",
      action: "reminders.read",
      description:
        'List Google Tasks as reminders, soonest due first. Filters: listIds, completed, dueBefore, overdue (open and due before today), dueToday, query (text in title or notes). For "what\'s due today": { dueToday: true, completed: false }.',
      inputSchema: obj({
        listIds: { type: "array", items: { type: "string" }, maxItems: 50 },
        completed: { type: "boolean" },
        dueBefore: iso,
        overdue: { type: "boolean" },
        dueToday: { type: "boolean" },
        query: { type: "string", maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        offset: { type: "integer", minimum: 0, maximum: 1_000_000 },
      }),
      sideEffect: "read",
      execute: (p, run) =>
        reading(async () => {
          const o = asObject(p ?? {});
          refuseUnsupported(o, ["flagged"]);
          const f: Parameters<GoogleTasks["list"]>[0] = {};
          if (o.listIds !== undefined) {
            if (!Array.isArray(o.listIds) || o.listIds.length > 50)
              throw new PsycheError("invalid_params", "listIds is a list of at most 50 ids");
            f.listIds = o.listIds.filter((x): x is string => typeof x === "string");
          }
          for (const k of ["completed", "overdue", "dueToday"] as const) {
            const v = bool(o[k], k);
            if (v !== undefined) f[k] = v;
          }
          const dueBefore = optString(o.dueBefore);
          if (dueBefore !== undefined) f.dueBefore = dueBefore;
          const query = textParam(o.query, "query", 200);
          if (query !== undefined) f.query = query;
          const limit = int(o.limit, "limit", 1, 500);
          if (limit !== undefined) f.limit = limit;
          const offset = int(o.offset, "offset", 0, 1_000_000);
          if (offset !== undefined) f.offset = offset;
          return out(await tasks.list(f, run.signal));
        }),
    },
    {
      name: "reminders_create",
      action: "reminders.write",
      description:
        "Add a task to Google Tasks (the first list unless listId). Google Tasks keeps the due day only. priority, url, alarm and recurrence are not supported and are refused.",
      inputSchema: obj(
        {
          listId: { type: "string" },
          title: { type: "string", minLength: 1, maxLength: 500 },
          notes: { type: "string", maxLength: 10_000 },
          due: iso,
          priority: { type: "integer", minimum: 0, maximum: 9 },
          url: { type: "string", maxLength: 2_000 },
          alarm: { type: "object" },
          recurrence: { type: "object" },
        },
        ["title"],
      ),
      sideEffect: "write",
      describeCall: bind("reminders_create"),
      execute: (p, run) =>
        writing(async () => {
          const o = asObject(p);
          refuseUnsupported(o, ["priority", "url", "alarm", "recurrence"]);
          return written(await tasks.create(writeOf(o), run.signal), "added");
        }),
    },
    {
      name: "reminders_update",
      action: "reminders.write",
      description:
        "Change a Google Tasks task: title, notes, due, completed. priority and the rest are not supported.",
      inputSchema: obj(
        {
          id: { type: "string" },
          title: { type: "string", minLength: 1, maxLength: 500 },
          notes: { type: "string", maxLength: 10_000 },
          due: iso,
          completed: { type: "boolean" },
          priority: { type: "integer", minimum: 0, maximum: 9 },
        },
        ["id"],
      ),
      sideEffect: "write",
      describeCall: bind("reminders_update"),
      execute: (p, run) =>
        writing(async () => {
          const o = asObject(p);
          if (typeof o.id !== "string") throw new PsycheError("invalid_params", "id is required");
          refuseUnsupported(o, ["priority"]);
          const w = writeOf(o);
          delete w.listId;
          return written(await tasks.update(o.id, w, run.signal), "changed");
        }),
    },
    {
      name: "reminders_complete",
      action: "reminders.write",
      description:
        'Mark a Google Tasks task done by id, or by its exact title in a list ("done with the dentist one"). completed: false reopens it.',
      inputSchema: obj({
        id: { type: "string" },
        title: { type: "string", maxLength: 500 },
        listId: { type: "string" },
        completed: { type: "boolean" },
      }),
      sideEffect: "write",
      describeCall: bind("reminders_complete"),
      execute: (p, run) =>
        writing(async () => {
          const o = asObject(p ?? {});
          const input: Parameters<GoogleTasks["complete"]>[0] = {};
          const id = optString(o.id);
          if (id !== undefined) input.id = id;
          const title = textParam(o.title, "title", 500);
          if (title !== undefined) input.title = title;
          const listId = optString(o.listId);
          if (listId !== undefined) input.listId = listId;
          const completed = bool(o.completed, "completed");
          if (completed !== undefined) input.completed = completed;
          const r = await tasks.complete(input, run.signal);
          return written(r, r.completed ? "completed" : "reopened");
        }),
    },
    {
      name: "reminders_set_flagged",
      action: "reminders.write",
      description: "Flag or unflag a task. Google Tasks has no Important flag, so this is refused.",
      inputSchema: obj({ id: { type: "string" }, flagged: { type: "boolean" } }, ["id", "flagged"]),
      sideEffect: "write",
      describeCall: bind("reminders_set_flagged"),
      execute: (p) =>
        writing(async () => {
          // Google Tasks has no Important flag: refuse, whatever the value.
          refuseUnsupported(asObject(p), ["flagged"]);
          return refused("flagged", "it has no Important flag");
        }),
    },
    {
      name: "reminders_delete",
      action: "reminders.delete",
      description:
        "Delete a Google Tasks task. Prefer reminders_complete for something that is done.",
      inputSchema: obj({ id: { type: "string" } }, ["id"]),
      sideEffect: "destructive",
      describeCall: bind("reminders_delete"),
      execute: (p, run) =>
        writing(async () => {
          const id = asObject(p).id;
          if (typeof id !== "string") throw new PsycheError("invalid_params", "id is required");
          await tasks.delete(id, run.signal);
          return {
            output: { deleted: true },
            provenance: "trusted",
            externalRefs: { reminderId: id },
            receiptSummary: `${LABEL}: deleted a task`,
          };
        }),
    },
  ];
}
