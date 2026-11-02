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
