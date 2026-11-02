import { type Static, type TProperties, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, StringEnum } from "../common.ts";
import { TaintSource } from "./permissions.ts";

/**
 * Generative UI (docs/design/generative-ui-2026.md). A widget spec is DATA: a tree of nodes from a
 * fixed catalogue, no script, no markup, no colours. Two layers:
 *
 * - The wire/entity types (`WidgetSpec`, `Widget`, `WidgetPatch`) are what travels and is stored.
 *   `WidgetSpec.root` is an open object on the wire so the codegen'd Swift/TS types stay flat (a
 *   recursive union does not survive quicktype) and a newer catalogue is not a wire break.
 * - The strict per-node schemas below (`WIDGET_NODE_SCHEMAS`) are what the Gateway validator
 *   (`validateWidgetSpec`, `widgets-validate.ts`) checks node by node. They are not part of the
 *   method/event registry, so they add nothing to the generated clients. Every one is
 *   `additionalProperties: false`: smuggled fields are rejected, not ignored.
 */

export const WIDGET_SPEC_VERSION = 1;

export const WidgetTone = StringEnum(["neutral", "info", "success", "warning", "danger"], {
  $id: "WidgetTone",
});
export type WidgetTone = Static<typeof WidgetTone>;

export const WidgetNodeId = Type.String({ pattern: "^[a-z0-9_-]{1,40}$" });

const Label = Type.String({ minLength: 1, maxLength: 500 });
const Str = Type.String({ maxLength: 500 });
const Strict = { additionalProperties: false } as const;

// Actions (§6.2). `tool` is accepted by the schema from P1 so specs stay stable; the renderer
// ships `tool` only in P7.
export const WidgetAction = Type.Union(
  [
    Type.Object(
      { kind: Type.Literal("reply"), text: Type.String({ minLength: 1, maxLength: 2000 }) },
      Strict,
    ),
    Type.Object(
      {
        kind: Type.Literal("answer"),
        inputRequestId: Id,
        value: Type.Union([Str, Type.Array(Str, { maxItems: 4 })]),
      },
      Strict,
    ),
    Type.Object(
      {
        kind: Type.Literal("open"),
        route: Type.Optional(Str),
        artifactId: Type.Optional(Id),
        fileId: Type.Optional(Id),
        url: Type.Optional(Type.String({ maxLength: 2000 })),
      },
      Strict,
    ),
    Type.Object(
      {
        kind: Type.Literal("tool"),
        tool: Type.String({ minLength: 1, maxLength: 120 }),
        args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      },
      Strict,
    ),
  ],
  { $id: "WidgetAction" },
);
export type WidgetAction = Static<typeof WidgetAction>;

// Live bindings (§5.4).
export const WidgetBindingSource = StringEnum(
  ["task", "automation", "research", "tool_call", "job"],
  { $id: "WidgetBindingSource" },
);
export const WidgetBind = Type.Object(
  { source: WidgetBindingSource, id: Id, field: Type.String({ minLength: 1, maxLength: 60 }) },
  { $id: "WidgetBind", ...Strict },
);
export type WidgetBind = Static<typeof WidgetBind>;

// Strict per-node schemas ---------------------------------------------------------------------

const base = {
  id: WidgetNodeId,
  fallbackText: Type.Optional(Str),
  bind: Type.Optional(WidgetBind),
};
const children = { children: Type.Array(Type.Unknown(), { maxItems: 60 }) };
const ItemState = StringEnum(["todo", "active", "done", "skipped", "failed"]);
const Gap = StringEnum(["none", "xs", "sm", "md", "lg"]);
const ColumnType = StringEnum(["text", "number", "date", "link"]);
const Cell = Type.Union([Str, Type.Number(), Type.Boolean(), Type.Null()]);

const node = <T extends string, P extends TProperties>(type: T, props: P) =>
  Type.Object({ ...base, type: Type.Literal(type), ...props }, Strict);

export const WIDGET_NODE_SCHEMAS = {
  stack: node("stack", {
    direction: Type.Optional(StringEnum(["vertical", "horizontal"])),
    gap: Type.Optional(Gap),
    ...children,
  }),
  grid: node("grid", {
    columns: Type.Integer({ minimum: 2, maximum: 4 }),
    gap: Type.Optional(Gap),
    ...children,
  }),
  tabs: node("tabs", {
    tabs: Type.Array(
      Type.Object({ id: WidgetNodeId, label: Label, children: children.children }, Strict),
      { minItems: 1, maxItems: 8 },
    ),
  }),
  card: node("card", {
    title: Type.Optional(Str),
    subtitle: Type.Optional(Str),
    tone: Type.Optional(WidgetTone),
    ...children,
  }),
  list: node("list", {
    items: Type.Array(
      Type.Object(
        {
          id: WidgetNodeId,
          title: Label,
          meta: Type.Optional(Str),
          action: Type.Optional(WidgetAction),
        },
        Strict,
      ),
      { maxItems: 100 },
    ),
  }),
  progress: node("progress", {
    label: Label,
    value: Type.Optional(Type.Number({ minimum: 0 })),
    max: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    indeterminate: Type.Optional(Type.Boolean()),
    steps: Type.Optional(
      Type.Array(Type.Object({ label: Label, state: ItemState }, Strict), { maxItems: 30 }),
    ),
    tone: Type.Optional(WidgetTone),
  }),
  checklist: node("checklist", {
    items: Type.Array(
      Type.Object(
        { id: WidgetNodeId, label: Label, state: ItemState, detail: Type.Optional(Str) },
        Strict,
      ),
      { maxItems: 100 },
    ),
  }),
  timeline: node("timeline", {
    entries: Type.Array(
      Type.Object(
        {
          id: WidgetNodeId,
          time: Type.Optional(Str),
          label: Label,
          tone: Type.Optional(WidgetTone),
        },
        Strict,
      ),
      { maxItems: 100 },
    ),
  }),
  status: node("status", { label: Label, tone: WidgetTone }),
  stat: node("stat", {
    label: Label,
    value: Type.Union([Str, Type.Number()]),
    unit: Type.Optional(Str),
    delta: Type.Optional(Str),
    tone: Type.Optional(WidgetTone),
  }),
  kv: node("kv", {
    rows: Type.Array(Type.Object({ label: Label, value: Str }, Strict), { maxItems: 50 }),
  }),
  table: node("table", {
    label: Label,
    columns: Type.Array(
      Type.Object(
        {
          key: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,40}$" }),
          label: Label,
          type: Type.Optional(ColumnType),
        },
        Strict,
      ),
      { minItems: 1, maxItems: 12 },
    ),
    rows: Type.Array(Type.Record(Type.String(), Cell), { maxItems: 500 }),
    sortable: Type.Optional(Type.Boolean()),
  }),
  chart: node("chart", {
    label: Label,
    kind: StringEnum(["bar", "line", "sparkline"]),
    unit: Type.Optional(Str),
    series: Type.Array(
      Type.Object(
        {
          name: Label,
          points: Type.Array(
            Type.Object({ x: Type.Union([Str, Type.Number()]), y: Type.Number() }, Strict),
            { maxItems: 365 },
          ),
        },
        Strict,
      ),
      { minItems: 1, maxItems: 4 },
    ),
  }),
  text: node("text", {
    text: Type.String({ maxLength: 500 }),
    emphasis: Type.Optional(StringEnum(["normal", "strong"])),
    tone: Type.Optional(WidgetTone),
  }),
  markdown: node("markdown", { md: Type.String({ maxLength: 8000 }) }),
  code: node("code", {
    code: Type.String({ maxLength: 8000 }),
    language: Type.Optional(Type.String({ maxLength: 40 })),
  }),
  image: node("image", {
    alt: Label,
    src: Type.Union([
      Type.Object({ fileId: Id }, Strict),
      Type.Object(
        {
          dataUrl: Type.String({
            pattern: "^data:image/(png|jpeg|gif|webp);base64,",
            maxLength: 262144,
          }),
        },
        Strict,
      ),
      Type.Object({ url: Type.String({ pattern: "^https://", maxLength: 2000 }) }, Strict),
    ]),
  }),
  map: node("map", {
    label: Label,
    places: Type.Array(
      Type.Object(
        {
          name: Label,
          address: Type.Optional(Str),
          lat: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
          lng: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
        },
        Strict,
      ),
      { minItems: 1, maxItems: 20 },
    ),
  }),
  link: node("link", { label: Label, url: Type.String({ maxLength: 2000 }) }),
  button: node("button", {
    label: Label,
    action: WidgetAction,
    tone: Type.Optional(WidgetTone),
  }),
  choices: node("choices", {
    label: Label,
    mode: StringEnum(["single", "multi"]),
    options: Type.Array(Type.Object({ id: WidgetNodeId, label: Label }, Strict), {
      minItems: 1,
      maxItems: 12,
    }),
    ask: Type.Optional(Type.Boolean()),
    action: Type.Optional(WidgetAction),
  }),
  form: node("form", {
    label: Label,
    fields: Type.Array(
      Type.Object(
        {
          id: WidgetNodeId,
          label: Label,
          type: StringEnum(["text", "textarea", "number", "select", "toggle", "date"]),
          required: Type.Optional(Type.Boolean()),
          options: Type.Optional(
            Type.Array(Type.Object({ id: WidgetNodeId, label: Label }, Strict), { maxItems: 20 }),
          ),
          placeholder: Type.Optional(Str),
        },
        Strict,
      ),
      { minItems: 1, maxItems: 12 },
    ),
    submit: Type.Object(
      {
        label: Label,
        as: StringEnum(["reply", "tool"]),
        tool: Type.Optional(Str),
        template: Type.Optional(Type.String({ maxLength: 2000 })),
      },
      Strict,
    ),
  }),
} as const;

export type WidgetNodeType = keyof typeof WIDGET_NODE_SCHEMAS;
export const WIDGET_NODE_TYPES = Object.keys(WIDGET_NODE_SCHEMAS) as WidgetNodeType[];

/** Wire type of a node: validated strictly by `validateWidgetSpec`, open here (see file header). */
export const WidgetNode = Type.Record(Type.String(), Type.Unknown(), {
  $id: "WidgetNode",
  description: "A catalogue node: { id, type, ...props }. Validated per type by the Gateway.",
});
export type WidgetNode = Static<typeof WidgetNode>;

export const WidgetSpec = Type.Object(
  {
    v: Type.Literal(WIDGET_SPEC_VERSION),
    title: Type.String({ minLength: 1, maxLength: 80 }),
    fallbackText: Type.String({ minLength: 1, maxLength: 2000 }),
    root: WidgetNode,
  },
  { $id: "WidgetSpec", additionalProperties: false },
);
export type WidgetSpec = Static<typeof WidgetSpec>;

// Patches (§5.2): ops are addressed by node id, never by JSON Pointer.
const OpProps = Type.Record(Type.String(), Type.Unknown());
export const WidgetOp = Type.Union(
  [
    Type.Object({ op: Type.Literal("set"), id: WidgetNodeId, props: OpProps }, Strict),
    Type.Object(
      {
        op: Type.Union([Type.Literal("append"), Type.Literal("prepend")]),
        id: WidgetNodeId,
        field: Type.String({ minLength: 1, maxLength: 40 }),
        items: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 100 }),
      },
      Strict,
    ),
    Type.Object({ op: Type.Literal("remove"), id: WidgetNodeId }, Strict),
    Type.Object({ op: Type.Literal("replace"), id: WidgetNodeId, node: WidgetNode }, Strict),
    Type.Object(
      {
        op: Type.Literal("meta"),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
        fallbackText: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
      },
      Strict,
    ),
  ],
  { $id: "WidgetOp" },
);
export type WidgetOp = Static<typeof WidgetOp>;

export const WidgetPatch = Type.Object(
  {
    widgetId: Id,
    baseRev: Type.Optional(Type.Integer({ minimum: 1 })),
    ops: Type.Array(WidgetOp, { minItems: 1, maxItems: 50 }),
  },
  { $id: "WidgetPatch", additionalProperties: false },
);
export type WidgetPatch = Static<typeof WidgetPatch>;

// Entity (§5.1) -------------------------------------------------------------------------------

export const WidgetOwner = Type.Union(
  [
    Type.Object({ kind: Type.Literal("run"), runId: Id }, Strict),
    Type.Object({ kind: Type.Literal("task"), taskId: Id }, Strict),
    Type.Object({ kind: Type.Literal("automation"), automationId: Id }, Strict),
    Type.Object({ kind: Type.Literal("job"), jobId: Id }, Strict),
  ],
  { $id: "WidgetOwner" },
);
export type WidgetOwner = Static<typeof WidgetOwner>;

export const WidgetState = StringEnum(["live", "frozen"], { $id: "WidgetState" });
export type WidgetState = Static<typeof WidgetState>;

export const Widget = Type.Object(
  {
    id: Id,
    threadId: Id,
    messageId: Id,
    rev: Type.Integer({ minimum: 1 }),
    spec: WidgetSpec,
    taint: Type.Array(TaintSource),
    owner: WidgetOwner,
    state: WidgetState,
    pinned: Type.Boolean(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  { $id: "Widget", additionalProperties: false },
);
export type Widget = Static<typeof Widget>;

/** Hard limits, enforced by the validator (§4.3). */
export const WIDGET_LIMITS = {
  specBytes: 32 * 1024,
  patchBytes: 8 * 1024,
  nodes: 200,
  depth: 8,
  string: 500,
  markdown: 8000,
  tableRowsStored: 500,
  tableRowsShown: 25,
  chartSeries: 4,
  chartPoints: 365,
  formFields: 12,
  buttonsPerContainer: 6,
  livePerThread: 8,
  pinned: 6,
} as const;
