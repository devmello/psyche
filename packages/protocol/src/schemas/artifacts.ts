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

/**
 * The content of a `chart` artifact (JSON), rendered by the client: no model-written JavaScript
 * (docs/design/chat-experience-2026.md §4.2, decision 4). `categories` label the x axis (or the
 * slices of a pie); each series has one value per category.
 */
export const ArtifactChart = Type.Object(
  {
    kind: StringEnum(["bar", "line", "area", "pie"]),
    title: Type.Optional(Type.String({ maxLength: 200 })),
    xLabel: Type.Optional(Type.String({ maxLength: 80 })),
    yLabel: Type.Optional(Type.String({ maxLength: 80 })),
    categories: Type.Array(Type.String({ maxLength: 80 }), { maxItems: 200 }),
    series: Type.Array(
      Type.Object({
        name: Type.String({ maxLength: 80 }),
        values: Type.Array(Type.Union([Type.Number(), Type.Null()]), { maxItems: 200 }),
      }),
      { minItems: 1, maxItems: 12 },
    ),
    stacked: Type.Optional(Type.Boolean()),
  },
  { $id: "ArtifactChart" },
);
export type ArtifactChart = Static<typeof ArtifactChart>;

const Lat = Type.Number({ minimum: -90, maximum: 90 });
const Lng = Type.Number({ minimum: -180, maximum: 180 });

/** One place on a `map` artifact. `id` is how patch ops address it. */
export const ArtifactMapMarker = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 40 }),
    lat: Lat,
    lng: Lng,
    label: Type.String({ maxLength: 120 }),
    note: Type.Optional(Type.String({ maxLength: 400 })),
    /** An http(s) link the marker's popup offers (checked again by the client before use). */
    link: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { $id: "ArtifactMapMarker" },
);
export type ArtifactMapMarker = Static<typeof ArtifactMapMarker>;

/**
 * The content of a `map` artifact (JSON): places the client draws on a map, or lists when it has
 * no tiles. The agent emits data only; coordinates come from connector results or web search, never
 * from a paid geocoder. Routes are polylines of `[lat, lng]` points.
 */
export const ArtifactMap = Type.Object(
  {
    title: Type.Optional(Type.String({ maxLength: 200 })),
    markers: Type.Array(ArtifactMapMarker, { maxItems: 500 }),
    routes: Type.Optional(
      Type.Array(
        Type.Object({
          label: Type.Optional(Type.String({ maxLength: 120 })),
          points: Type.Array(Type.Tuple([Lat, Lng]), { minItems: 2, maxItems: 2000 }),
        }),
        { maxItems: 20 },
      ),
    ),
    /** `[south, west, north, east]`; fitted to the markers when omitted. */
    bounds: Type.Optional(Type.Tuple([Lat, Lng, Lat, Lng])),
  },
  { $id: "ArtifactMap" },
);
export type ArtifactMap = Static<typeof ArtifactMap>;

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

/** `updateMarker`'s field changes. Named so Swift codegen doesn't emit a type called `Set`. */
export const ArtifactMarkerPatch = Type.Object(
  {
    lat: Type.Optional(Lat),
    lng: Type.Optional(Lng),
    label: Type.Optional(Type.String({ maxLength: 120 })),
    note: Type.Optional(Nullable(Type.String({ maxLength: 400 }))),
    link: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
  },
  { $id: "ArtifactMarkerPatch" },
);
export type ArtifactMarkerPatch = Static<typeof ArtifactMarkerPatch>;

/** A workbook cell: a value, or `{f}` for a formula (`=` is not typed; `SUM(A1:A3)`). */
export const ArtifactFormulaCell = Type.Object(
  { f: Type.String({ minLength: 1, maxLength: 2000 }) },
  { $id: "ArtifactFormulaCell" },
);
export type ArtifactFormulaCell = Static<typeof ArtifactFormulaCell>;

export const ArtifactWorkbookCell = Type.Union(
  [Type.String(), Type.Number(), Type.Boolean(), Type.Null(), ArtifactFormulaCell],
  { $id: "ArtifactWorkbookCell" },
);
export type ArtifactWorkbookCell = Static<typeof ArtifactWorkbookCell>;

/** One sheet: sparse cells keyed by A1 (`B3`; `A1` is the first row, headers included). */
export const ArtifactWorkbookSheet = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 31 }),
    cells: Type.Record(
      Type.String({ pattern: "^[A-Z]{1,3}[1-9][0-9]{0,5}$" }),
      ArtifactWorkbookCell,
    ),
  },
  { $id: "ArtifactWorkbookSheet" },
);
export type ArtifactWorkbookSheet = Static<typeof ArtifactWorkbookSheet>;

/** The content of a `workbook` artifact (JSON): one or more sheets with values and formulas. */
export const ArtifactWorkbook = Type.Object(
  { sheets: Type.Array(ArtifactWorkbookSheet, { minItems: 1, maxItems: 50 }) },
  { $id: "ArtifactWorkbook" },
);
export type ArtifactWorkbook = Static<typeof ArtifactWorkbook>;

export const ArtifactSlideLayout = StringEnum(
  ["title", "bullets", "image", "two-column", "blank"],
  {
    $id: "ArtifactSlideLayout",
  },
);
export type ArtifactSlideLayout = Static<typeof ArtifactSlideLayout>;

/** One slide. `id` is how patch ops address it. `image` is a Library item id or an https URL. */
export const ArtifactSlide = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 40 }),
    layout: ArtifactSlideLayout,
    title: Type.Optional(Type.String({ maxLength: 200 })),
    bullets: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 30 })),
    /** The right column of a `two-column` slide. */
    bullets2: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 30 })),
    image: Type.Optional(Type.String({ maxLength: 1000 })),
    notes: Type.Optional(Type.String({ maxLength: 4000 })),
  },
  { $id: "ArtifactSlide" },
);
export type ArtifactSlide = Static<typeof ArtifactSlide>;

export const ArtifactDeckTheme = StringEnum(["light", "dark", "contrast"], {
  $id: "ArtifactDeckTheme",
});
export type ArtifactDeckTheme = Static<typeof ArtifactDeckTheme>;

/** The content of a `slides` artifact (JSON). */
export const ArtifactDeck = Type.Object(
  {
    theme: ArtifactDeckTheme,
    slides: Type.Array(ArtifactSlide, { maxItems: 300 }),
  },
  { $id: "ArtifactDeck" },
);
export type ArtifactDeck = Static<typeof ArtifactDeck>;

/** `updateSlide`'s field changes (named so Swift codegen doesn't emit a type called `Set`). */
export const ArtifactSlidePatch = Type.Object(
  {
    layout: Type.Optional(ArtifactSlideLayout),
    title: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
    bullets: Type.Optional(Nullable(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 30 }))),
    bullets2: Type.Optional(
      Nullable(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 30 })),
    ),
    image: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
    notes: Type.Optional(Nullable(Type.String({ maxLength: 4000 }))),
  },
  { $id: "ArtifactSlidePatch" },
);
export type ArtifactSlidePatch = Static<typeof ArtifactSlidePatch>;

/**
 * One edit. Text types (`doc`, `code`): `replace` (`old` must match exactly once, else the update
 * fails fast), `insert` after an exact-once anchor (empty anchor = at the start), or `rewrite`
 * (the fallback; counted). Tables: `set`, `setRange`, `addRows`, `deleteRows`, `addColumn`, and
 * `view` (sort and filter metadata). Charts: `patch` (JSON merge patch). Maps: `addMarker`, `removeMarker`, `updateMarker`, `patch`. Header row is not addressable: `A1` is the first data row.
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
    /** `map`: add, remove or update one marker by id. */
    Type.Object({ op: Type.Literal("addMarker"), marker: ArtifactMapMarker }),
    Type.Object({ op: Type.Literal("removeMarker"), id: Type.String({ minLength: 1 }) }),
    Type.Object({
      op: Type.Literal("updateMarker"),
      id: Type.String({ minLength: 1 }),
      /** Fields to change; `null` clears `note` or `link`. */
      set: ArtifactMarkerPatch,
    }),
    /** `doc`: replace, append after, or remove a section by its heading text (the heading line stays on replace). */
    Type.Object({
      op: Type.Literal("replaceSection"),
      heading: Type.String({ minLength: 1 }),
      body: Type.String(),
    }),
    Type.Object({
      op: Type.Literal("addSection"),
      /** Insert after this section; at the end when omitted. */
      after: Type.Optional(Type.String({ minLength: 1 })),
      level: Type.Integer({ minimum: 1, maximum: 6 }),
      heading: Type.String({ minLength: 1 }),
      body: Type.String(),
    }),
    Type.Object({ op: Type.Literal("removeSection"), heading: Type.String({ minLength: 1 }) }),
    /** `slides`: add, update, remove or move one slide by id; set the theme. */
    Type.Object({
      op: Type.Literal("addSlide"),
      slide: ArtifactSlide,
      /** Zero-based index to insert at; at the end when omitted. */
      at: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    Type.Object({
      op: Type.Literal("updateSlide"),
      id: Type.String({ minLength: 1 }),
      changes: ArtifactSlidePatch,
    }),
    Type.Object({ op: Type.Literal("removeSlide"), id: Type.String({ minLength: 1 }) }),
    Type.Object({
      op: Type.Literal("moveSlide"),
      id: Type.String({ minLength: 1 }),
      to: Type.Integer({ minimum: 0 }),
    }),
    Type.Object({ op: Type.Literal("setTheme"), theme: ArtifactDeckTheme }),
    /** `workbook`: set cells on a sheet (A1 → value or {f}; null clears), add, rename or remove a sheet. */
    Type.Object({
      op: Type.Literal("setCells"),
      sheet: Type.String({ minLength: 1 }),
      cells: Type.Record(
        Type.String({ pattern: "^[A-Z]{1,3}[1-9][0-9]{0,5}$" }),
        ArtifactWorkbookCell,
      ),
    }),
    Type.Object({
      op: Type.Literal("addSheet"),
      name: Type.String({ minLength: 1, maxLength: 31 }),
    }),
    Type.Object({
      op: Type.Literal("renameSheet"),
      sheet: Type.String({ minLength: 1 }),
      name: Type.String({ minLength: 1, maxLength: 31 }),
    }),
    Type.Object({ op: Type.Literal("removeSheet"), sheet: Type.String({ minLength: 1 }) }),
    /** `chart`: a JSON merge patch (RFC 7386) onto the spec; arrays are replaced whole. */
    Type.Object({
      op: Type.Literal("patch"),
      patch: Type.Record(Type.String(), Type.Unknown()),
    }),
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
