import { getWidgets } from "@psyche/db";
import type { MethodParams, MethodResult } from "@psyche/protocol";
import type { Call } from "../context.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * Generative-UI widgets (docs/design/generative-ui-2026.md). P1 serves snapshots by id; the agent
 * tools, patching and freezing arrive with P3.
 */
export function composeWidgets(services: ComposeServices): ComposedPart {
  return {
    handlers: {
      "widgets.get": {
        run: (_c: Call, p: MethodParams<"widgets.get">): MethodResult<"widgets.get"> => {
          const widgets = getWidgets(services.db, p.widgetIds);
          const found = new Set(widgets.map((w) => w.id));
          return { widgets, missing: p.widgetIds.filter((id) => !found.has(id)) };
        },
      },
    },
  };
}
