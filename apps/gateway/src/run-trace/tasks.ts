import { createRun, finishRun, getRun, type PsycheDb, updateRun, upsertToolCall } from "@psyche/db";
import type {
  AgentEvent,
  EventName,
  EventPayload,
  RunOrigin,
  RunOutcome,
  Task,
} from "@psyche/protocol";
import type { TaskTurn, TaskTurnTrace } from "@psyche/tasks";
import type { RunTraceSink } from "./sink.ts";

/**
 * Task and automation turns in the run trace (docs/design/run-trace-2026.md §4.2): each turn of
 * the task worker is its own run, written like a chat turn: a `runs` row, `tool_calls` and the
 * sink's `run_steps`, with `run.updated`, `tool_call.updated` and `run.step` published. A
 * specialist's turn is a child run of the run that spawned it; an automation's names its
 * `automation_runs` row, which in turn names the run and its usage.
 */

export interface TaskRunTraceDeps {
  db: PsycheDb;
  /** The Gateway's sink, once it is listening. */
  sink: () => RunTraceSink | undefined;
  publish: <E extends EventName>(event: E, payload: EventPayload<E>, threadId?: string) => void;
  /** The model a task turn runs on (the router's primary). */
  modelRef: string;
  onError?: (error: unknown) => void;
}

function originOf(task: Task): RunOrigin {
  switch (task.createdFrom) {
    case "automation":
      return "automation";
    case "subagent":
      return "subagent";
    case "channel":
      return "channel";
    default:
      return "owner";
  }
}

/** A specialist turn's outcome as its spawn step's status. */
const SPAWN_STATUS: Record<RunOutcome, "ok" | "failed" | "cancelled" | "waiting"> = {
  final: "ok",
  no_reply: "ok",
  failed: "failed",
  cancelled: "cancelled",
  awaiting_approval: "waiting",
  awaiting_input: "waiting",
};

const ENDED: Record<RunOutcome, "done" | "failed" | "cancelled" | null> = {
  final: "done",
  no_reply: "done",
  failed: "failed",
  cancelled: "cancelled",
  awaiting_approval: null,
  awaiting_input: null,
};

export function taskRunTrace(deps: TaskRunTraceDeps): TaskTurnTrace {
  const { db, publish } = deps;
  const run = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      deps.onError?.(err);
    }
  };

  return {
    start(turn: TaskTurn) {
      run(() => {
        const task = turn.task;
        const spec = task.specialist;
        const automationRun =
          task.createdFrom === "automation"
            ? (db.sqlite
                .prepare(
                  "SELECT id FROM automation_runs WHERE task_id = ? ORDER BY started_at DESC, id DESC LIMIT 1",
                )
                .get(task.id) as { id: string } | undefined)
            : undefined;
        const parent = spec?.parentRunId == null ? undefined : getRun(db, spec.parentRunId);
        const created = createRun(db, {
          id: turn.runId,
          threadId: task.threadId,
          modelRef: deps.modelRef,
          kind: automationRun === undefined ? "task" : "automation",
          origin: originOf(task),
          title: task.title.slice(0, 160),
          taskId: task.id,
          automationRunId: automationRun?.id ?? null,
          parentRunId: parent?.id ?? null,
          rootRunId: parent === undefined ? null : (parent.rootRunId ?? parent.id),
          ...(spec === undefined
            ? {}
            : {
                specialist: { role: spec.role },
                budget: spec.budget,
                deadline: spec.deadline ?? null,
              }),
        });
        if (automationRun !== undefined) {
          db.sqlite
            .prepare("UPDATE automation_runs SET run_id = ? WHERE id = ?")
            .run(turn.runId, automationRun.id);
        }
        publish("run.updated", { run: created }, task.threadId);
        const sink = deps.sink();
        sink?.begin(turn.runId, task.threadId);
        if (parent !== undefined) sink?.linkChild(parent.id, task.id, turn.runId);
      });
    },

    event(turn: TaskTurn, event: AgentEvent) {
      run(() => {
        const threadId = turn.task.threadId;
        const runId = turn.runId;
        if (event.type === "end") return;
        const stepId = deps.sink()?.apply(runId, threadId, event);
        switch (event.type) {
          case "tool_call": {
            const toolCall = upsertToolCall(db, {
              id: event.toolCallId,
              runId,
              tool: event.tool,
              status: event.status,
              ...(event.details ?? {}),
              ...(stepId === undefined ? {} : { stepId }),
            });
            publish("tool_call.updated", { toolCall }, threadId);
            return;
          }
          case "run.status": {
            // The end of the turn settles the run (`end`).
            if (
              event.status === "done" ||
              event.status === "failed" ||
              event.status === "cancelled"
            )
              return;
            publish(
              "run.updated",
              { run: updateRun(db, runId, { status: event.status }) },
              threadId,
            );
            return;
          }
          case "approval_requested":
            publish(
              "run.updated",
              { run: updateRun(db, runId, { status: "awaiting_approval" }) },
              threadId,
            );
            return;
          case "question":
            publish(
              "run.updated",
              { run: updateRun(db, runId, { status: "awaiting_input" }) },
              threadId,
            );
            return;
          case "usage":
            publish("run.updated", { run: updateRun(db, runId, { usage: event.usage }) }, threadId);
            return;
          default:
            return;
        }
      });
    },

    end(turn: TaskTurn, outcome: RunOutcome, error?: string) {
      run(() => {
        const threadId = turn.task.threadId;
        const sink = deps.sink();
        sink?.end(turn.runId, outcome);
        // The parent's spawn step follows the specialist's job to its outcome.
        const parentRunId = turn.task.specialist?.parentRunId;
        if (parentRunId != null) {
          sink?.linkChild(parentRunId, turn.task.id, turn.runId, SPAWN_STATUS[outcome]);
        }
        const status = ENDED[outcome];
        const updated =
          status === null
            ? updateRun(db, turn.runId, {
                status: outcome === "awaiting_approval" ? "awaiting_approval" : "awaiting_input",
              })
            : finishRun(db, turn.runId, {
                status,
                // Errors can echo tool output: redacted like every trace text (§4.6).
                ...(error === undefined ? {} : { error: deps.sink()?.redactDeep(error) ?? error }),
              });
        if (updated.automationRunId != null) {
          db.sqlite
            .prepare("UPDATE automation_runs SET usage = ? WHERE id = ?")
            .run(JSON.stringify(updated.usage), updated.automationRunId);
        }
        publish("run.updated", { run: updated }, threadId);
      });
    },
  };
}
