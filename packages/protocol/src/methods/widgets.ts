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
      "A click on a widget button or form that proposes a tool call (generative-ui-2026 §6.2, D2). The call and its arguments come from the widget's stored spec, never from this request (only the owner's form values do). The Gateway records a visible owner message with a from-widget marker and starts a turn whose first step is that call, through the Permission Broker with the widget's taint as requester taint: never weaker than the model calling the tool. If the policy says ask, the real approval card appears in the dock.",
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
