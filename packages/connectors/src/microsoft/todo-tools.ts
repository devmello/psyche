import { PsycheError } from "@psyche/protocol";
import { asObject, optString } from "../framework/params.ts";
import type { ConnectorAction, ConnectorTool, ToolOutput } from "../framework/types.ts";
import { actionBinding } from "../mail/binding.ts";
import { normalizeScope } from "./auth.ts";
import {
  type GraphTodo,
  ownerOnlyTodo,
  type ReminderAlarm,
  type ReminderFilter,
  type ReminderRecurrence,
  type ReminderWrite,
  type TodoReminderView,
} from "./todo.ts";

/**
 * The `reminders_*` tools over Microsoft To Do: the Apple Reminders adapter's names, schemas,
 * matrix rows (`reminders.read` allow; `reminders.write` and `reminders.delete` ask, as
 * `connector_action`), outputs (`{ lists }`, `{ reminders }`, `{ reminder }`, `{ deleted }`,
 * `{ flagged }`) and bindings (every write binds to its exact arguments), so the agent and the
 * Gateway's readers use the same calls on To Do as on Reminders.
 */

export const TODO_ACTIONS: ConnectorAction[] = [
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

/** Whether the granted scopes include To Do (`Tasks.Read` or `Tasks.ReadWrite`). */
export function hasTodoScope(scopes: readonly string[]): boolean {
  return scopes.some((s) => {
    const n = normalizeScope(s);
    return n === "tasks.read" || n === "tasks.readwrite";
  });
}

const iso = { type: "string", format: "date-time" };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const alarmSchema = {
  anyOf: [
    {
      type: "object",
      properties: { relativeMinutes: { type: "integer", minimum: -40_320, maximum: 0 } },
      required: ["relativeMinutes"],
      additionalProperties: false,
    },
    { type: "object", properties: { at: iso }, required: ["at"], additionalProperties: false },
  ],
};
const recurrenceSchema = {
  type: "object",
  properties: {
    frequency: { type: "string", enum: ["daily", "weekly", "monthly", "yearly"] },
    interval: { type: "integer", minimum: 1, maximum: 999 },
    daysOfWeek: {
      type: "array",
      items: { type: "string", enum: ["mo", "tu", "we", "th", "fr", "sa", "su"] },
      maxItems: 7,
    },
    until: iso,
    count: { type: "integer", minimum: 1, maximum: 999 },
  },
  required: ["frequency"],
  additionalProperties: false,
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

function alarmOf(v: unknown): ReminderAlarm | undefined {
  if (v === undefined) return undefined;
  const o = asObject(v);
  if (typeof o.at === "string") return { at: o.at };
  if (typeof o.relativeMinutes === "number") return { relativeMinutes: o.relativeMinutes };
  throw new PsycheError("invalid_params", "alarm is { at } or { relativeMinutes }");
}

function recurrenceOf(v: unknown): ReminderRecurrence | undefined {
  if (v === undefined) return undefined;
  const o = asObject(v);
  const f = o.frequency;
  if (f !== "daily" && f !== "weekly" && f !== "monthly" && f !== "yearly")
    throw new PsycheError(
      "invalid_params",
      "recurrence.frequency is daily, weekly, monthly or yearly",
    );
  const out: ReminderRecurrence = { frequency: f };
  const interval = int(o.interval, "recurrence.interval", 1, 999);
  if (interval !== undefined) out.interval = interval;
  if (Array.isArray(o.daysOfWeek))
    out.daysOfWeek = o.daysOfWeek.filter((d): d is string => typeof d === "string");
  const until = optString(o.until);
  if (until !== undefined) out.until = until;
  const count = int(o.count, "recurrence.count", 1, 999);
  if (count !== undefined) out.count = count;
  return out;
}

function writeOf(o: Record<string, unknown>): ReminderWrite {
  const w: ReminderWrite = {};
  const listId = optString(o.listId);
  if (listId !== undefined) w.listId = listId;
  const title = textParam(o.title, "title", 500);
  if (title !== undefined) w.title = title;
  const notes = textParam(o.notes, "notes", 10_000);
  if (notes !== undefined) w.notes = notes;
  if (o.due === null) w.due = null;
  else {
    const due = optString(o.due);
    if (due !== undefined) w.due = due;
  }
  const completed = bool(o.completed, "completed");
  if (completed !== undefined) w.completed = completed;
  const priority = int(o.priority, "priority", 0, 9);
  if (priority !== undefined) w.priority = priority;
  const url = textParam(o.url, "url", 2_000);
  if (url !== undefined) w.url = url;
  const alarm = alarmOf(o.alarm);
  if (alarm !== undefined) w.alarm = alarm;
  const recurrence = recurrenceOf(o.recurrence);
  if (recurrence !== undefined) w.recurrence = recurrence;
  return w;
}

function filterOf(o: Record<string, unknown>): ReminderFilter {
  const f: ReminderFilter = {};
  if (o.listIds !== undefined) {
    if (!Array.isArray(o.listIds) || o.listIds.length > 50)
      throw new PsycheError("invalid_params", "listIds is a list of at most 50 ids");
    f.listIds = o.listIds.filter((x): x is string => typeof x === "string");
  }
  for (const k of ["completed", "overdue", "dueToday", "flagged"] as const) {
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
  return f;
}

/** Owner content when every row is attested the owner's own; anything else is untrusted. */
function out(
  output: unknown,
  rows: readonly { shared: boolean; createdBy?: string }[],
  extra: Partial<ToolOutput> = {},
): ToolOutput {
  return { output, provenance: ownerOnlyTodo(rows) ? "trusted" : "untrusted", ...extra };
}

const LABEL = "Microsoft To Do";
const short = (s: string) => (s.length > 60 ? `${s.slice(0, 59)}…` : s);

export function todoTools(deps: {
  connectorId: string;
  todo: GraphTodo;
  guard: <T>(fn: () => Promise<T>) => Promise<T>;
}): ConnectorTool[] {
  const { todo, guard } = deps;
  const bind = (name: string) => (p: unknown) => actionBinding(deps.connectorId, name, p);
  const written = (r: TodoReminderView, verb: string) =>
    out({ reminder: r }, [r], {
      externalRefs: { reminderId: r.id },
      receiptSummary: `${LABEL}: ${verb} "${short(r.title)}"`,
    });
  return [
    {
      name: "reminders_list_lists",
      action: "reminders.read",
      description: "List the Microsoft To Do lists (id, title, writable, shared).",
      inputSchema: obj({}),
      sideEffect: "read",
      execute: (_p, run) =>
        guard(async () => {
          const lists = await todo.lists(run.signal);
          return out({ lists }, lists);
        }),
    },
    {
      name: "reminders_list",
      action: "reminders.read",
      description:
        'List Microsoft To Do tasks as reminders, soonest due first. Filters: listIds, completed, dueBefore, overdue (open and due before today), dueToday, flagged (marked Important), query (text in title or notes). For "what\'s due today": { dueToday: true, completed: false }.',
      inputSchema: obj({
        listIds: { type: "array", items: { type: "string" }, maxItems: 50 },
        completed: { type: "boolean" },
        dueBefore: iso,
        overdue: { type: "boolean" },
        dueToday: { type: "boolean" },
        flagged: { type: "boolean" },
        query: { type: "string", maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        offset: { type: "integer", minimum: 0, maximum: 1_000_000 },
      }),
      sideEffect: "read",
      execute: (p, run) =>
        guard(async () => {
          const r = await todo.list(filterOf(asObject(p ?? {})), run.signal);
          return out(r, r.reminders);
        }),
    },
    {
      name: "reminders_create",
      action: "reminders.write",
      description:
        "Add a task to Microsoft To Do (the default Tasks list unless listId). To Do keeps the due day, not its time: use alarm for a time (at a time, or minutes before the due day starts). Priority 1–4 marks it Important, 6–9 low. url keeps a link with it (e.g. the email it came from), recurrence repeats it (needs due).",
      inputSchema: obj(
        {
          listId: { type: "string" },
          title: { type: "string", minLength: 1, maxLength: 500 },
          notes: { type: "string", maxLength: 10_000 },
          due: iso,
          priority: { type: "integer", minimum: 0, maximum: 9 },
          url: { type: "string", maxLength: 2_000 },
          alarm: alarmSchema,
          recurrence: recurrenceSchema,
        },
        ["title"],
      ),
      sideEffect: "write",
      describeCall: bind("reminders_create"),
      execute: (p, run) =>
        guard(async () => written(await todo.create(writeOf(asObject(p)), run.signal), "added")),
    },
    {
      name: "reminders_update",
      action: "reminders.write",
      description: "Change a To Do task: title, notes, due (null clears it), completed, priority.",
      inputSchema: obj(
        {
          id: { type: "string" },
          title: { type: "string", minLength: 1, maxLength: 500 },
          notes: { type: "string", maxLength: 10_000 },
          due: { anyOf: [iso, { type: "null" }] },
          completed: { type: "boolean" },
          priority: { type: "integer", minimum: 0, maximum: 9 },
        },
        ["id"],
      ),
      sideEffect: "write",
      describeCall: bind("reminders_update"),
      execute: (p, run) =>
        guard(async () => {
          const o = asObject(p);
          if (typeof o.id !== "string") throw new PsycheError("invalid_params", "id is required");
          // Only what the schema offers: moving lists, links, alarms and repeats is not an update.
          const w = writeOf(o);
          delete w.listId;
          delete w.url;
          delete w.alarm;
          delete w.recurrence;
          return written(await todo.update(o.id, w, run.signal), "changed");
        }),
    },
    {
      name: "reminders_complete",
      action: "reminders.write",
      description:
        'Mark a To Do task done by id, or by its exact title in a list ("done with the dentist one"). completed: false reopens it.',
      inputSchema: obj({
        id: { type: "string" },
        title: { type: "string", maxLength: 500 },
        listId: { type: "string" },
        completed: { type: "boolean" },
      }),
      sideEffect: "write",
      describeCall: bind("reminders_complete"),
      execute: (p, run) =>
        guard(async () => {
          const o = asObject(p ?? {});
          const input: Parameters<GraphTodo["complete"]>[0] = {};
          const id = optString(o.id);
          if (id !== undefined) input.id = id;
          const title = textParam(o.title, "title", 500);
          if (title !== undefined) input.title = title;
          const listId = optString(o.listId);
          if (listId !== undefined) input.listId = listId;
          const completed = bool(o.completed, "completed");
          if (completed !== undefined) input.completed = completed;
          const r = await todo.complete(input, run.signal);
          return written(r, r.completed ? "completed" : "reopened");
        }),
    },
    {
      name: "reminders_set_flagged",
      action: "reminders.write",
      description: "Flag or unflag a To Do task (To Do's Important star).",
      inputSchema: obj({ id: { type: "string" }, flagged: { type: "boolean" } }, ["id", "flagged"]),
      sideEffect: "write",
      describeCall: bind("reminders_set_flagged"),
      execute: (p, run) =>
        guard(async () => {
          const o = asObject(p);
          const flagged = bool(o.flagged, "flagged");
          if (typeof o.id !== "string" || flagged === undefined)
            throw new PsycheError("invalid_params", "id and flagged are required");
          const r = await todo.setFlagged(o.id, flagged, run.signal);
          return out({ flagged, reminder: r }, [r], {
            externalRefs: { reminderId: r.id },
            receiptSummary: `${LABEL}: ${flagged ? "flagged" : "unflagged"} "${short(r.title)}"`,
          });
        }),
    },
    {
      name: "reminders_delete",
      action: "reminders.delete",
      description: "Delete a To Do task. Prefer reminders_complete for something that is done.",
      inputSchema: obj({ id: { type: "string" } }, ["id"]),
      sideEffect: "destructive",
      describeCall: bind("reminders_delete"),
      execute: (p, run) =>
        guard(async () => {
          const id = asObject(p).id;
          if (typeof id !== "string") throw new PsycheError("invalid_params", "id is required");
          await todo.delete(id, run.signal);
          return {
            output: { deleted: true },
            provenance: "untrusted",
            externalRefs: { reminderId: id },
            receiptSummary: `${LABEL}: deleted a task`,
          };
        }),
    },
  ];
}
