import { getWidgets } from "@psyche/db";
import type { MethodParams, MethodResult } from "@psyche/protocol";
import type { Call } from "../context.ts";
import { WidgetStore } from "../widgets/store.ts";
import { widgetTools } from "../widgets/tools.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * Generative-UI widgets (docs/design/generative-ui-2026.md). Snapshots by id, and the agent's `render_ui`, `update_ui` and
 * `list_ui` tools (deferred by default: not in `ALWAYS_ON`).
 */
export function composeWidgets(services: ComposeServices): ComposedPart {
  const store = new WidgetStore({
    db: services.db,
    publish: (event, payload, threadId) => services.publish(event, payload, threadId),
  });
  const unregister = widgetTools(store).map((t) => services.tools.register(t));
  return {
    stop: () => {
      store.flush();
      for (const u of unregister) u();
    },
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
