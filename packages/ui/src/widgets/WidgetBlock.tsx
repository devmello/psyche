import { lazy, type ReactElement, Suspense } from "react";
import type { BlockOf } from "../blocks/types.ts";
import { DelayedSkeleton } from "../components/DelayedSkeleton.tsx";
import { useWidget } from "../data/index.ts";
import { t } from "../i18n/core.ts";

/**
 * The `ui` block (generative-ui-2026 §2, §9): a pointer to a widget entity. The renderer is a lazy
 * chunk loaded on the first widget of a session; nothing of it is in the main bundle.
 */
const WidgetView = lazy(() => import("./WidgetView.tsx"));

export function WidgetBlockView({ block }: { block: BlockOf<"ui"> }): ReactElement {
  const { widget, loading, error, reload } = useWidget(block.widgetId);
  if (widget === null) {
    if (loading) return <DelayedSkeleton label={t("widgets.frame.loading")} />;
    return (
      <p className="my-1 text-sm text-muted-foreground" data-testid="widget-missing">
        {t("widgets.frame.missing")}
        {error !== null ? (
          <button type="button" className="ms-2 underline" onClick={reload}>
            {t("widgets.frame.retry")}
          </button>
        ) : null}
      </p>
    );
  }
  return (
    <Suspense fallback={<DelayedSkeleton label={t("widgets.frame.loading")} />}>
      <WidgetView widget={widget} />
    </Suspense>
  );
}
