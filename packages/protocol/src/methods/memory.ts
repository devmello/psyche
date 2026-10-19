import { Type } from "@sinclair/typebox";
import { IsoDateTime, StringEnum } from "../common.ts";
import { MemoryHit } from "../schemas/memory.ts";
import { defineMethod } from "./define.ts";

/** `memory.*` (architecture §4.8; data model §7). Paths are relative to the workspace. */

/** Workspace-relative path: no leading slash, no `..` segment. The Gateway still canonicalizes. */
export const WorkspacePath = Type.String({
  minLength: 1,
  maxLength: 1024,
  pattern: "^(?![/\\\\])(?!.*(^|[/\\\\])\\.\\.([/\\\\]|$)).+$",
  description: 'Workspace-relative path, e.g. "memory/2026-10-18.md"',
  $id: "WorkspacePath",
});

export const MemoryMethods = {
  "memory.search": defineMethod({
    params: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 2000 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    result: Type.Object({ hits: Type.Array(MemoryHit) }),
    scope: "operator.read",
    description: "Hybrid search (FTS5 + vectors) over memory chunks.",
  }),
  "memory.read": defineMethod({
    params: Type.Object({
      path: WorkspacePath,
      lineStart: Type.Optional(Type.Integer({ minimum: 1 })),
      lineEnd: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    result: Type.Object({
      path: WorkspacePath,
      content: Type.String(),
      updatedAt: IsoDateTime,
    }),
    scope: "operator.read",
    description: "Reads a workspace memory file, optionally a line range.",
  }),
  "memory.write": defineMethod({
    params: Type.Object({
      path: WorkspacePath,
      content: Type.String({ maxLength: 1_000_000 }),
      mode: Type.Optional(StringEnum(["replace", "append"], { $id: "MemoryWriteMode" })),
    }),
    result: Type.Object({
      path: WorkspacePath,
      bytes: Type.Integer({ minimum: 0 }),
      updatedAt: IsoDateTime,
    }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Writes a workspace memory file (default replace). Protected files may require an approval. Side-effecting.",
  }),
} as const;
