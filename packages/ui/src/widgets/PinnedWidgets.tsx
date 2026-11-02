import { type ReactElement, useEffect } from "react";
import { useGatewayQuery, useStore, useStoreState } from "../data/index.ts";
import { put } from "../data/state.ts";
import { t } from "../i18n/core.ts";
import { ScreenSection } from "../screens/feed/ScreenToolbar.tsx";
import { WidgetBlockView } from "./WidgetBlock.tsx";

/**
 * Home's pinned widgets (generative-ui-2026 §8, D5; docs/design/consolidation-2026.md §3.1): up
 * to 6 across the app, kept live by their bindings (a scheduled task's status, a background job's
 * progress) with no model involved. Drawn as a section of their own (cards never nest), in the
 * same host frame as in the chat, with `open` and `reply` controls only. Nothing shows until
 * something is pinned.
 */
export function PinnedWidgets(): ReactElement | null {
  const store = useStore();
  const q = useGatewayQuery("widgets.list", { pinned: true });
  const loaded = q.data?.widgets;
  useEffect(() => {
    if (loaded === undefined) return;
    store.update((s) => loaded.reduce((acc, w) => put(acc, "widgets", w), s));
  }, [loaded, store]);
  const states = useStoreState((s) => s.widgets);
  const ids = (loaded ?? []).map((w) => w.id).filter((id) => states[id]?.pinned !== false);
  if (ids.length === 0) return null;
  return (
    <ScreenSection id="pinned" title={t("widgets.overview.title")}>
      <div className="flex flex-col gap-1">
        {ids.map((id) => (
          <WidgetBlockView key={id} block={{ type: "ui", widgetId: id }} surface="overview" />
        ))}
      </div>
    </ScreenSection>
  );
}
