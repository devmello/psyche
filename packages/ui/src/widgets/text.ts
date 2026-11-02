import { type WidgetSpec, widgetFallbackText } from "@psyche/protocol";

/** The copy-as-text rendering: the title, then the shared fallback (also what channels get). */
export function widgetText(spec: WidgetSpec): string {
  return `${spec.title}\n${widgetFallbackText(spec)}`;
}
