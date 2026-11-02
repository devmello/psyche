import { Type } from "@sinclair/typebox";
import { Id } from "../common.ts";
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
} as const;
