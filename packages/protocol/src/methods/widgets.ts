import { Type } from "@sinclair/typebox";
import { Id, StringEnum } from "../common.ts";
import { Widget } from "../schemas/widgets.ts";
import { defineMethod } from "./define.ts";

/** `widgets.*`: generative-UI widget snapshots (docs/design/generative-ui-2026.md §5). */
export const WidgetsMethods = {
  "widgets.get": defineMethod({
    params: Type.Object({ widgetIds: Type.Array(Id, { minItems: 1, maxItems: 100 }) }),
    result: Type.Object({
      widgets: Type.Array(Widget),
      missing: Type.Array(Id, { description: "Ids that do not exist or are not visible" }),
    }),
    scope: "operator.read",
    description:
      "Returns the latest snapshot of widgets by id (one batched call per history page or reconnect).",
  }),
  "widgets.pin": defineMethod({
    params: Type.Object({ widgetId: Id, pinned: Type.Boolean() }, { additionalProperties: false }),
    result: Type.Object({ widget: Widget }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Pins a widget to the Overview or unpins it (generative-ui-2026 §8, D5). At most 6 pinned widgets across the app; a pinned widget keeps its live bindings and its taint. Side-effecting.",
  }),
  "widgets.list": defineMethod({
    params: Type.Object({ pinned: Type.Literal(true) }, { additionalProperties: false }),
    result: Type.Object({ widgets: Type.Array(Widget) }),
    scope: "operator.read",
    description: "The pinned widgets, most recently pinned first (the Overview's Pinned block).",
  }),
  "widgets.act": defineMethod({
    params: Type.Object(
      {
        widgetId: Id,
        nodeId: Type.String({ pattern: "^[a-z0-9_-]{1,40}$" }),
        itemId: Type.Optional(Type.String({ pattern: "^[a-z0-9_-]{1,40}$" })),
        values: Type.Optional(
          Type.Record(
            Type.String({ pattern: "^[a-z0-9_-]{1,40}$" }),
            Type.Union([Type.String({ maxLength: 2000 }), Type.Number(), Type.Boolean()]),
            { maxProperties: 12 },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    result: Type.Object({ messageId: Id, runId: Type.Union([Id, Type.Null()]) }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "A click on a widget button or form that proposes a tool call (generative-ui-2026 §6.2, D2). The call and its arguments come from the widget's stored spec, never from this request (only the owner's form values do). The Gateway records a visible owner message with a from-widget marker and starts a turn whose first step is that call, through the Permission Broker with the widget's taint as requester taint: never weaker than the model calling the tool. If the policy says ask, the real approval card appears in the dock. Side-effecting.",
  }),
  "widgets.preview": defineMethod({
    params: Type.Object(
      {
        widgetId: Id,
        nodeId: Type.String({ pattern: "^[a-z0-9_-]{1,40}$" }),
        itemId: Type.Optional(Type.String({ pattern: "^[a-z0-9_-]{1,40}$" })),
      },
      { additionalProperties: false },
    ),
    result: Type.Object({
      tool: Type.String(),
      decision: StringEnum(["allow", "ask", "deny", "device-only", "unavailable"]),
    }),
    scope: "operator.read",
    description:
      "What the Permission Broker would answer a widget control's tool call right now (a dry run: nothing runs, nothing is asked), so the control can say \"asks first\". Uses the widget's taint.",
  }),
  "widgets.binding.resolve": defineMethod({
    params: Type.Object(
      { widgetId: Id, nodeId: Type.String({ pattern: "^[a-z0-9_-]{1,40}$" }) },
      { additionalProperties: false },
    ),
    result: Type.Object({
      available: Type.Boolean({
        description:
          "False when the bound call is gone or not in the widget's chat (renders Unavailable)",
      }),
      status: Type.Optional(
        Type.String({
          description: "Tool call status; for research also `cancelled` when it stopped",
        }),
      ),
      claims: Type.Optional(Type.Integer({ minimum: 0 })),
      sources: Type.Optional(Type.Integer({ minimum: 0 })),
      step: Type.Optional(
        Type.Integer({ minimum: 0, description: "Research steps reached, 0 to `steps`" }),
      ),
      steps: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    scope: "operator.read",
    description:
      "Reads the live value behind a widget node's `tool_call` or `research` binding (generative-ui-2026 §5.4), the same facts the desktop shows: the tool call's status, and for deep research the claim and source counts and the step reached. Task, job and automation bindings are read with their own methods. Research counts come from `research.progress` events the Gateway saw since it started; after a restart a finished call reads as done with no counts.",
  }),
  "widgets.image": defineMethod({
    params: Type.Object({
      widgetId: Id,
      url: Type.String({ pattern: "^https://", maxLength: 2000 }),
    }),
    result: Type.Object({
      mime: StringEnum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
      bytes: Type.String({ description: "base64, at most 512 KiB decoded" }),
    }),
    scope: "operator.read",
    description:
      "Fetches one remote image a widget shows (generative-ui-2026 §7.2, D3), through the Gateway: only when the owner turned `widgets.remoteImages` on, only a URL that is in that widget's stored spec, https only, no cookies or referrer, private addresses refused, image types only (never SVG), 512 KiB cap.",
  }),
} as const;
