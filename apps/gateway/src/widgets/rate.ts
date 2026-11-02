import { PsycheError } from "@psyche/protocol";

/**
 * One widget click per widget per second (generative-ui-2026 §7.5): a widget cannot be made into
 * a message cannon or a call cannon, whatever its spec says.
 */
const WIDGET_CLICK_MS = 1000;
const last = new Map<string, number>();

export function claimWidgetClick(widgetId: string, now = Date.now()): void {
  if (now - (last.get(widgetId) ?? 0) < WIDGET_CLICK_MS) {
    throw new PsycheError("rate_limited", "That widget was just used; wait a moment.", {
      retryable: true,
    });
  }
  last.set(widgetId, now);
  if (last.size > 500) last.clear();
}
