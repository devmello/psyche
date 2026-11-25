import { asRecord, bareTool, preview, str, toolPrefix } from "./common.ts";
import type {
  Adapter,
  CaptureResult,
  CheckResult,
  InverseCall,
  Json,
  ReadRegistry,
  ReminderInfo,
  StagedCall,
} from "./types.ts";

/**
 * Reminders (§2.3). Precondition: modification date plus a snapshot. Stale when changed or gone;
 * for a create, a duplicate title in the same list. Inverse: create -> delete, complete ->
 * uncomplete, update -> restore the snapshot.
 */

const TOOLS = ["reminders_create", "reminders_update", "reminders_complete"] as const;
const NON_FIELD = new Set(["id", "listId", "title_lookup"]);

async function readReminder(
  registry: ReadRegistry,
  id: string,
): Promise<ReminderInfo | null | "unreadable"> {
  try {
    return await registry.reminder(id);
  } catch {
    return "unreadable";
  }
}

/** The reminder a complete call means: by id, or by an exact title in a list (exactly one match). */
async function resolveId(
  registry: ReadRegistry,
  a: Record<string, unknown>,
): Promise<{ id: string } | { reason: string }> {
  const id = str(a.id);
  if (id) return { id };
  const title = str(a.title);
  if (!title) return { reason: "bad_reminder" };
  try {
    const hits = await registry.remindersFind({ title, listId: str(a.listId) });
    if (hits.length === 0) return { reason: "reminder_gone" };
    if (hits.length > 1) return { reason: "ambiguous_title" };
    return { id: (hits[0] as ReminderInfo).id };
  } catch {
    return { reason: "reminders_unreadable" };
  }
}

function fieldKeys(call: StagedCall): string[] {
  if (bareTool(call) === "reminders_complete") return ["completed"];
  return Object.keys(call.args)
    .filter((k) => !NON_FIELD.has(k))
    .sort();
}

export function remindersAdapter(registry: ReadRegistry): Adapter {
  return {
    tools: TOOLS,

    async capture(call): Promise<CaptureResult> {
      const a = call.args;
      if (bareTool(call) === "reminders_create") {
        const title = str(a.title);
        if (!title) return { ok: false, reason: "bad_reminder" };
        const listId = str(a.listId);
        let dupes: ReminderInfo[];
        try {
          dupes = await registry.remindersFind({ title, listId });
        } catch {
          return { ok: false, reason: "reminders_unreadable" };
        }
        if (dupes.length > 0) return { ok: false, reason: "duplicate" };
        return {
          ok: true,
          target: `create:${listId ?? ""}|${title}`,
          precondition: { create: true, title, listId: listId ?? null },
          before: {},
        };
      }

      const resolved = await resolveId(registry, a);
      if ("reason" in resolved) return { ok: false, reason: resolved.reason };
      const r = await readReminder(registry, resolved.id);
      if (r === "unreadable") return { ok: false, reason: "reminders_unreadable" };
      if (!r) return { ok: false, reason: "reminder_gone" };
      const before: Record<string, Json> = {};
      for (const k of fieldKeys(call)) {
        before[k] =
          k === "completed" ? r.completed : (r.fields[k] ?? (k === "title" ? r.title : null));
      }
      return {
        ok: true,
        target: r.id,
        precondition: { modifiedAt: r.modifiedAt },
        before,
      };
    },

    async check(_call, capture): Promise<CheckResult> {
      const pre = asRecord(capture.precondition);
      if (pre.create === true) {
        const title = str(pre.title);
        if (!title) return { fresh: false, reason: "bad_reminder" };
        try {
          const dupes = await registry.remindersFind({
            title,
            listId: typeof pre.listId === "string" ? pre.listId : undefined,
          });
          return dupes.length > 0 ? { fresh: false, reason: "duplicate" } : { fresh: true };
        } catch {
          return { fresh: false, reason: "reminders_unreadable" };
        }
      }
      const r = await readReminder(registry, capture.target);
      if (r === "unreadable") return { fresh: false, reason: "reminders_unreadable" };
      if (!r) return { fresh: false, reason: "reminder_gone" };
      if (r.modifiedAt !== pre.modifiedAt) return { fresh: false, reason: "changed" };
      return { fresh: true };
    },

    preview(call, capture) {
      const a = call.args;
      if (bareTool(call) === "reminders_create") {
        return preview("reminder", "Add a reminder", [
          ["Title", a.title],
          ["Due", a.due],
          ["Notes", a.notes],
        ]);
      }
      if (bareTool(call) === "reminders_complete") {
        return preview(
          "reminder",
          a.completed === false ? "Reopen a reminder" : "Complete a reminder",
          [["Reminder", capture.target]],
        );
      }
      const before = asRecord(capture.before);
      return preview("reminder", "Change a reminder", [
        ["Reminder", capture.target],
        ...fieldKeys(call).map((k): [string, unknown] => [
          k,
          `${show(before[k])} -> ${show(a[k])}`,
        ]),
      ]);
    },

    inverse(call, capture, created): InverseCall | undefined {
      if (bareTool(call) === "reminders_create") {
        if (!created?.id) return undefined;
        return {
          tool: `${toolPrefix(call.tool)}reminders_delete`,
          args: { id: created.id },
          destructive: true,
        };
      }
      if (bareTool(call) === "reminders_complete") {
        return {
          tool: `${toolPrefix(call.tool)}reminders_complete`,
          args: { id: capture.target, completed: call.args.completed === false },
        };
      }
      return {
        tool: `${toolPrefix(call.tool)}reminders_update`,
        args: { id: capture.target, ...asRecord(capture.before) },
      };
    },

    async postState(call, capture, created): Promise<Json> {
      const id = bareTool(call) === "reminders_create" ? created?.id : capture.target;
      if (!id) return null;
      const r = await readReminder(registry, id);
      return r === "unreadable" || !r ? null : { modifiedAt: r.modifiedAt };
    },

    async checkInverse(call, capture, post, created): Promise<CheckResult> {
      const id = bareTool(call) === "reminders_create" ? created?.id : capture.target;
      if (!id) return { fresh: false, reason: "no_created_id" };
      const r = await readReminder(registry, id);
      if (r === "unreadable") return { fresh: false, reason: "reminders_unreadable" };
      if (!r) return { fresh: false, reason: "reminder_gone" };
      if (r.modifiedAt !== asRecord(post).modifiedAt) {
        return { fresh: false, reason: "changed_since_apply" };
      }
      return { fresh: true };
    },
  };
}

function show(v: unknown): string {
  return v === undefined || v === null ? "(none)" : typeof v === "string" ? v : JSON.stringify(v);
}
