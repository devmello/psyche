import { Type } from "@sinclair/typebox";
import { Id } from "../common.ts";
import { SpecialistJob, SpecialistRole } from "../schemas/specialists.ts";
import { defineMethod, nextCursor, pageParams } from "./define.ts";

/**
 * `specialists.*` (docs/agent/specialists-2026.md §7.2). The parent/child run tree that mission
 * control shows is `runs.children` / `runs.list {parentRunId}` (docs/design/run-trace-2026.md §4.4).
 */

export const SpecialistsMethods = {
  "specialists.list": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ roles: Type.Array(SpecialistRole) }),
    scope: "operator.read",
    description:
      "Lists the specialist roles (from skills with a specialist section) with the owner's settings: on/off, model, budgets, caps and max mode.",
  }),
  "specialists.jobs": defineMethod({
    params: Type.Object({
      status: Type.Optional(
        Type.Array(
          Type.Union([
            Type.Literal("queued"),
            Type.Literal("working"),
            Type.Literal("needs_you"),
            Type.Literal("done"),
            Type.Literal("partial"),
            Type.Literal("failed"),
            Type.Literal("cancelled"),
          ]),
        ),
      ),
      threadId: Type.Optional(Id),
      ...pageParams,
    }),
    result: Type.Object({ jobs: Type.Array(SpecialistJob), ...nextCursor }),
    scope: "operator.read",
    description:
      "Lists specialist jobs, newest first: queued (with their place), working, needing the owner, and finished with their result.",
  }),
} as const;
