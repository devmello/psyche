import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime } from "../common.ts";
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
  "tasks.steer": defineMethod({
    params: Type.Object({
      taskId: Id,
      text: Type.String({ minLength: 1, maxLength: 4000 }),
    }),
    result: TaskResult,
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Steers a running task (a specialist job): the text reaches the running turn as owner guidance, or opens its next turn when parked. Side-effecting: a duplicate would steer twice.",
  }),
  "tasks.update": defineMethod({
    params: Type.Object({
      taskId: Id,
      budget: Type.Optional(
        Type.Object({
          tokens: Type.Optional(Type.Integer({ minimum: 1 })),
          costUsd: Type.Optional(Type.Number({ minimum: 0 })),
          minutes: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
      ),
      deadline: Type.Optional(IsoDateTime),
    }),
    result: TaskResult,
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Changes a specialist job's budget limits or deadline (owner only; capped by Settings). A paused-on-budget job resumes. Side-effecting: a duplicate would apply twice.",
  }),
  "tasks.actions": defineMethod({
    params: Type.Object({ taskId: Id, ...pageParams }),
    result: Type.Object({ actions: Type.Array(TaskAction), ...nextCursor }),
    scope: "operator.read",
    description: "Pages a task's Activity lines (level 1 and 2; level 3 is fetched by ref).",
  }),
} as const;
