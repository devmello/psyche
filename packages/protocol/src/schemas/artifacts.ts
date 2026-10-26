import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { ArtifactType } from "./surfaces.ts";

/**
 * Canvas artifacts and their versions (docs/design/chat-experience-2026.md §4.3, §4.4). The model
 * emits small typed data and patch ops; the Gateway stores every version and hands the model back
 * a reference (`ArtifactRef`), never the body. Content is read on demand (`artifacts.read`).
 */

/** Who wrote a version: the agent, the user editing in the canvas, or a specialist job. */
export const ArtifactAuthor = StringEnum(["agent", "user", "specialist"], {
  $id: "ArtifactAuthor",
});
export type ArtifactAuthor = Static<typeof ArtifactAuthor>;

/** One table cell. */
export const ArtifactCell = Type.Union(
  [Type.String(), Type.Number(), Type.Boolean(), Type.Null()],
  { $id: "ArtifactCell" },
);
export type ArtifactCell = Static<typeof ArtifactCell>;

/** The content of a `table` artifact (JSON): named columns and rows of cells. */
export const ArtifactTable = Type.Object(
  {
    columns: Type.Array(Type.String(), { maxItems: 200 }),
    rows: Type.Array(Type.Array(ArtifactCell, { maxItems: 200 }), { maxItems: 10_000 }),
  },
  { $id: "ArtifactTable" },
);
export type ArtifactTable = Static<typeof ArtifactTable>;

/** An A1 cell (`B3`) or range (`A1:C4`) reference into a table artifact. */
const A1 = Type.String({ pattern: "^[A-Z]{1,3}[1-9][0-9]{0,5}$" });
const A1Range = Type.String({
  pattern: "^[A-Z]{1,3}[1-9][0-9]{0,5}:[A-Z]{1,3}[1-9][0-9]{0,5}$",
});

/** Table sort and filter, stored as view metadata (rows are never reordered by them). */
export const ArtifactTableView = Type.Object(
  {
    sort: Type.Optional(
      Nullable(Type.Object({ column: Type.String(), dir: StringEnum(["asc", "desc"]) })),
    ),
    filter: Type.Optional(
      Nullable(Type.Object({ column: Type.String(), contains: Type.String() })),
    ),
  },
  { $id: "ArtifactTableView" },
);
export type ArtifactTableView = Static<typeof ArtifactTableView>;

/**
 * One edit. Text types (`doc`, `code`): `replace` (`old` must match exactly once, else the update
 * fails fast), `insert` after an exact-once anchor (empty anchor = at the start), or `rewrite`
 * (the fallback; counted). Tables: `set`, `setRange`, `addRows`, `deleteRows`, `addColumn`, and
 * `view` (sort and filter metadata). Header row is not addressable: `A1` is the first data row.
 */
export const ArtifactOp = Type.Union(
  [
    Type.Object({
      op: Type.Literal("replace"),
      old: Type.String({ minLength: 1 }),
      new: Type.String(),
    }),
    Type.Object({ op: Type.Literal("insert"), after: Type.String(), text: Type.String() }),
    Type.Object({ op: Type.Literal("rewrite"), content: Type.String() }),
    Type.Object({ op: Type.Literal("set"), cell: A1, value: ArtifactCell }),
    Type.Object({
      op: Type.Literal("setRange"),
      range: A1Range,
      values: Type.Array(Type.Array(ArtifactCell)),
    }),
    Type.Object({
      op: Type.Literal("addRows"),
      rows: Type.Array(Type.Array(ArtifactCell), { minItems: 1 }),
      /** Zero-based row index to insert before; at the end when omitted. */
      at: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    Type.Object({
      op: Type.Literal("deleteRows"),
      at: Type.Integer({ minimum: 0 }),
      count: Type.Integer({ minimum: 1 }),
    }),
    Type.Object({
      op: Type.Literal("addColumn"),
      name: Type.String({ minLength: 1 }),
      values: Type.Optional(Type.Array(ArtifactCell)),
      at: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    Type.Object({ op: Type.Literal("view"), view: ArtifactTableView }),
  ],
  { $id: "ArtifactOp" },
);
export type ArtifactOp = Static<typeof ArtifactOp>;

/** What a tool result carries instead of the body (§4.3 rule 1). */
export const ArtifactRef = Type.Object(
  {
    artifactId: Id,
    version: Type.Integer({ minimum: 1 }),
    type: ArtifactType,
    title: Type.String(),
    bytes: Type.Integer({ minimum: 0 }),
    /** sha256 of the version's full content, hex. */
    hash: Type.String(),
    /** A short summary for the model, e.g. "12 rows × 4 columns" or "1 replace, +3 lines". */
    summary: Type.String(),
  },
  { $id: "ArtifactRef" },
);
export type ArtifactRef = Static<typeof ArtifactRef>;

/** One stored version: the ops that made it, or a full snapshot (every N versions or large ops). */
export const ArtifactVersion = Type.Object(
  {
    artifactId: Id,
    version: Type.Integer({ minimum: 1 }),
    author: ArtifactAuthor,
    kind: StringEnum(["snapshot", "ops"]),
    /** The ops that produced this version from the previous one. */
    ops: Type.Optional(Type.Array(ArtifactOp)),
    bytes: Type.Integer({ minimum: 0 }),
    hash: Type.String(),
    summary: Type.String(),
    /** The run and tool call that wrote it (agent and specialist versions), for run-trace links. */
    runId: Nullable(Id),
    toolCallId: Nullable(Id),
    /** The version this one was restored from (`artifacts.restore`). */
    restoredFrom: Type.Optional(Type.Integer({ minimum: 1 })),
    createdAt: IsoDateTime,
  },
  { $id: "ArtifactVersion" },
);
export type ArtifactVersion = Static<typeof ArtifactVersion>;

/** What an update that lost the race gets back instead of a new version (§4.4). */
export const ArtifactConflict = Type.Object(
  {
    base: Type.Integer({ minimum: 1 }),
    latest: Type.Integer({ minimum: 1 }),
    /** The versions written since `base`, oldest first. */
    missed: Type.Array(ArtifactVersion),
  },
  { $id: "ArtifactConflict" },
);
export type ArtifactConflict = Static<typeof ArtifactConflict>;
