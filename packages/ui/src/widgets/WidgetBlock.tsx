import type { FeedWidget, Widget } from "@psyche/protocol";
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

/**
 * A widget snapshot on a Feed post (generative-ui-2026 §8, D8): static (no bindings, no patches, no
 * remote images), drawn in the same frame as in the chat, with `open` and `reply` controls only; its
 * taint travels with it. Its id is not a stored widget, so it never reaches the Gateway as one.
 */
export function FeedWidgetView({
  postId,
  snapshot,
}: {
  postId: string;
  snapshot: FeedWidget;
}): ReactElement {
  const widget: Widget = {
    id: `feed:${postId}`,
    threadId: "",
    messageId: "",
    rev: 1,
    spec: snapshot.spec,
    taint: snapshot.taint,
    owner: { kind: "run", runId: "" },
    state: "frozen",
    pinned: false,
    createdAt: "1970-01-01T00:00:00Z",
    updatedAt: "1970-01-01T00:00:00Z",
  };
  return (
    <Suspense fallback={<DelayedSkeleton label={t("widgets.frame.loading")} />}>
      <WidgetView widget={widget} surface="feed" />
    </Suspense>
  );
}

export function WidgetBlockView({
  block,
  surface = "chat",
}: {
  block: BlockOf<"ui">;
  surface?: "chat" | "overview";
}): ReactElement {
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
      <WidgetView widget={widget} surface={surface} />
    </Suspense>
  );
}
