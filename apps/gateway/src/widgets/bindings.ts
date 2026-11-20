import { getRun, getToolCall, type PsycheDb } from "@psyche/db";
import {
  collectWidgetBinds,
  PsycheError,
  type TaintSource,
  type WidgetBind,
} from "@psyche/protocol";
import { isProjectOrChild } from "../compose/space-queries.ts";

/**
 * Checks a widget's bindings when the spec is drawn or patched (generative-ui-2026 §5.4, §7.3).
 * A binding may only name an entity of the widget's own chat (automations belong to the owner, so
 * any chat may show them). Another chat's entity and a missing one answer the same, so ids cannot
 * be probed. The entity's taint joins the widget's: a bound task that read untrusted content
 * makes the widget untrusted too.
 */

interface TaskRow {
  thread_id: string;
  specialist: string | null;
  taint: number | null;
  taint_sources: string | null;
}

const RESEARCH_TOOLS = new Set(["research_run", "research_followup"]);

function taskTaint(row: TaskRow): TaintSource[] {
  if (row.taint_sources) {
    try {
      const parsed = JSON.parse(row.taint_sources) as TaintSource[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // fall through to the flag
    }
  }
  return row.taint === 1 ? [{ sourceKind: "task" }] : [];
}

function notVisible(bind: WidgetBind): PsycheError {
  return new PsycheError(
    "invalid_params",
    `The binding ${bind.source}:${bind.id} was rejected: no such ${bind.source.replace("_", " ")}${bind.source === "automation" ? "" : " in this chat"}. Bind only to things that exist (and, except automations, were started in this chat), or drop the bind and use update_ui.`,
  );
}

function check(
  db: PsycheDb,
  bind: WidgetBind,
  threadId: string,
  spaceId?: string | null,
): TaintSource[] {
  switch (bind.source) {
    case "task":
    case "job": {
      const row = db.sqlite
        .prepare("SELECT thread_id, specialist, taint, taint_sources FROM tasks WHERE id = ?")
        .get(bind.id) as TaskRow | undefined;
      if (row === undefined) throw notVisible(bind);
      let parent: string | undefined;
      if (row.specialist) {
        try {
          parent = (JSON.parse(row.specialist) as { parentThreadId?: string }).parentThreadId;
        } catch {
          parent = undefined;
        }
      }
      if (bind.source === "job" && row.specialist === null) throw notVisible(bind);
      if (row.thread_id !== threadId && parent !== threadId) throw notVisible(bind);
      return taskTaint(row);
    }
    case "tool_call":
    case "research": {
      const call = getToolCall(db, bind.id);
      const run = call === undefined ? undefined : getRun(db, call.runId);
      if (call === undefined || run === undefined || run.threadId !== threadId)
        throw notVisible(bind);
      if (bind.source === "research" && !RESEARCH_TOOLS.has(call.tool)) throw notVisible(bind);
      return call.taintOut ? [{ sourceKind: call.tool, toolCallId: call.id }] : [];
    }
    case "automation": {
      const row = db.sqlite.prepare("SELECT 1 AS ok FROM automations WHERE id = ?").get(bind.id);
      if (row === undefined) throw notVisible(bind);
      return [];
    }
    // The Space query sources (spaces-2026 §6.2): only inside a Space, and only on that Space's
    // own data. The Space is the chat's, or the shelf's when the Gateway draws a template.
    case "entity":
    case "work_due":
    case "calendar":
    case "reminders":
    case "mail":
    case "files": {
      const space = spaceRow(db, spaceId ?? threadSpace(db, threadId));
      if (space === undefined || space.archived_at !== null) throw notInSpace(bind);
      if (bind.source === "entity") {
        if (space.entity_id === null || !isProjectOrChild(db, space.entity_id, bind.id))
          throw notInSpace(bind);
      } else if (bind.id !== space.id) {
        throw notInSpace(bind);
      }
      // The sources whose values are always someone else's text taint the widget at bind time;
      // the rest add theirs when a value is written (the resolver says which).
      return bind.source === "mail"
        ? [{ sourceKind: "email" }]
        : bind.source === "files"
          ? [{ sourceKind: "file_names" }]
          : [];
    }
  }
}

function threadSpace(db: PsycheDb, threadId: string): string | null {
  const row = db.sqlite.prepare("SELECT space_id FROM threads WHERE id = ?").get(threadId) as
    | { space_id: string | null }
    | undefined;
  return row?.space_id ?? null;
}

function spaceRow(
  db: PsycheDb,
  id: string | null,
): { id: string; entity_id: string | null; archived_at: string | null } | undefined {
  if (id === null) return undefined;
  return db.sqlite.prepare("SELECT id, entity_id, archived_at FROM spaces WHERE id = ?").get(id) as
    | { id: string; entity_id: string | null; archived_at: string | null }
    | undefined;
}

function notInSpace(bind: WidgetBind): PsycheError {
  return new PsycheError(
    "invalid_params",
    `The binding ${bind.source}:${bind.id} was rejected: ${bind.source} reads a Space's own data, so it works only in a chat inside a Space, with ${bind.source === "entity" ? "the Space's linked project (or one of its parts)" : "the Space's own id"} as id. Drop the bind or use update_ui.`,
  );
}

/**
 * The taint every binding in `root` adds; throws an error the model can read for a bad one.
 * `spaceId` is the Space a tracker is drawn for when the caller is the Gateway itself (a template).
 */
export function checkWidgetBindings(
  db: PsycheDb,
  root: unknown,
  threadId: string,
  spaceId?: string | null,
): TaintSource[] {
  const out: TaintSource[] = [];
  for (const { bind } of collectWidgetBinds(root)) out.push(...check(db, bind, threadId, spaceId));
  return out;
}
