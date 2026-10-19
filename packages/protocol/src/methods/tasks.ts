import { type Static, Type } from "@sinclair/typebox";
import { Id } from "../common.ts";
import { Task, TaskAction, TaskStatus } from "../schemas/tasks.ts";
import { defineMethod, nextCursor, pageParams } from "./define.ts";

/** `tasks.*` (architecture §4.5; data model §3). */

export const TaskResult = Type.Object({ task: Task }, { $id: "TaskResult" });
export type TaskResult = Static<typeof TaskResult>;

const TaskIdParams = Type.Object({ taskId: Id }, { $id: "TaskIdParams" });

export const TasksMethods = {
  "tasks.list": defineMethod({
    params: Type.Object({
      status: Type.Optional(Type.Array(TaskStatus)),
      threadId: Type.Optional(Id),
      ...pageParams,
    }),
    result: Type.Object({ tasks: Type.Array(Task), ...nextCursor }),
    scope: "operator.read",
    description: "Lists tasks, most recently updated first.",
  }),
  "tasks.get": defineMethod({
    params: TaskIdParams,
    result: TaskResult,
    scope: "operator.read",
    description: "Returns one task with its plan and checklist.",
  }),
  "tasks.pause": defineMethod({
    params: TaskIdParams,
    result: TaskResult,
    scope: "operator.write",
    description: "Pauses a running task at the next checkpoint.",
  }),
  "tasks.resume": defineMethod({
    params: TaskIdParams,
    result: TaskResult,
    scope: "operator.write",
    description: "Resumes a paused task.",
  }),
  "tasks.cancel": defineMethod({
    params: TaskIdParams,
    result: TaskResult,
    scope: "operator.write",
    description: "Cancels a task; in-flight side effects are recorded as uncertain.",
  }),
  "tasks.retry": defineMethod({
    params: Type.Object({ taskId: Id, fromStepId: Type.Optional(Id) }),
    result: TaskResult,
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Starts a new attempt of a failed or cancelled task, optionally from a step. Side-effecting: a duplicate would start a second attempt.",
  }),
  "tasks.actions": defineMethod({
    params: Type.Object({ taskId: Id, ...pageParams }),
    result: Type.Object({ actions: Type.Array(TaskAction), ...nextCursor }),
    scope: "operator.read",
    description: "Pages a task's Activity lines (level 1 and 2; level 3 is fetched by ref).",
  }),
} as const;
