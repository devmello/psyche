import { Type } from "@sinclair/typebox";
import { IsoDateTime, Provenance } from "../common.ts";
import { defineMethod } from "./define.ts";
import { WorkspacePath } from "./memory.ts";

/**
 * `memory.notes.*`: what Psyche noted for its own future use (docs/05 §8). Notes are files under
 * `memory/agent/`; the owner lists and deletes them here. Deleting is the owner's own write, and
 * only ever inside that folder, never a protected file.
 */

/** Folder of the agent's own notes, relative to the workspace. */
export const AGENT_NOTES_DIR = "memory/agent/";

export const AgentNote = Type.Object(
  {
    path: WorkspacePath,
    /** Last change. */
    updatedAt: IsoDateTime,
    /** Start of the note, bullets and headings as written (capped). */
    text: Type.String(),
    bytes: Type.Integer({ minimum: 0 }),
    /** Least-trusted class of the file's content: `untrusted` notes are never recalled. */
    provenance: Provenance,
  },
  { $id: "AgentNote" },
);

export const AgentNotesMethods = {
  "memory.notes.list": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ notes: Type.Array(AgentNote) }),
    scope: "operator.read",
    description: "Lists the notes Psyche keeps for itself (memory/agent/*.md), newest first.",
  }),
  "memory.notes.delete": defineMethod({
    params: Type.Object({ path: WorkspacePath }),
    result: Type.Object({ removed: Type.Boolean() }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Deletes one agent note as the owner (removed false when it is already gone). Only files under memory/agent/ qualify. Side-effecting.",
  }),
} as const;
