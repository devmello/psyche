import { getRun, getToolCall, type PsycheDb } from "@psyche/db";
import {
  collectWidgetBinds,
  PsycheError,
  type TaintSource,
  type WidgetBind,
} from "@psyche/protocol";

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

function check(db: PsycheDb, bind: WidgetBind, threadId: string): TaintSource[] {
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
  }
}

/** The taint every binding in `root` adds; throws an error the model can read for a bad one. */
export function checkWidgetBindings(db: PsycheDb, root: unknown, threadId: string): TaintSource[] {
  const out: TaintSource[] = [];
  for (const { bind } of collectWidgetBinds(root)) out.push(...check(db, bind, threadId));
  return out;
}
