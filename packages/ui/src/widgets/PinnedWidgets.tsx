import { type ReactElement, useEffect, useId } from "react";
import { useGatewayQuery, useStore, useStoreState } from "../data/index.ts";
import { put } from "../data/state.ts";
import { t } from "../i18n/core.ts";
import { WidgetBlockView } from "./WidgetBlock.tsx";

/**
 * The Overview's pinned widgets (generative-ui-2026 §8, D5): up to 6 across the app, kept live by
 * their bindings (a scheduled task's status, a background job's progress) with no model involved.
 * Drawn outside the section cards (those never nest), in the same host frame as in the chat, with
 * `open` and `reply` controls only. Nothing shows until something is pinned.
 */
export function PinnedWidgets(): ReactElement | null {
  const store = useStore();
  const heading = useId();
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
    <section
      aria-labelledby={heading}
      data-testid="overview-pinned"
      className="flex flex-col gap-1"
    >
      <h3 id={heading} className="text-headline text-label-secondary">
        {t("widgets.overview.title")}
      </h3>
      {ids.map((id) => (
        <WidgetBlockView key={id} block={{ type: "ui", widgetId: id }} surface="overview" />
      ))}
    </section>
  );
}
