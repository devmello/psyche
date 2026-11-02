import { LayoutPanelTop } from "lucide-react";
import { type ReactElement, useMemo } from "react";
import type { WidgetDraftState } from "../data/state.ts";
import { t } from "../i18n/core.ts";
import { WidgetContext } from "./context.ts";
import { RenderNode } from "./nodes.tsx";

/**
 * The preview of a widget the model is still writing (generative-ui-2026 §5.5, P9). The Gateway
 * sends only nodes that are complete and validate, minus every control and picture, so this draws
 * a read-only sketch under a "Building widget…" header and a skeleton for what has not arrived.
 * The committed widget replaces it with the real frame; a draft is never stored or interactive.
 * The skeleton is still under reduced motion (`motion-safe`).
 */
export default function WidgetDraft({
  draft,
}: {
  draft: Pick<WidgetDraftState, "callId" | "threadId" | "title" | "root" | "nodes">;
}): ReactElement {
  const ctx = useMemo(
    () => ({
      threadId: draft.threadId,
      widgetId: `draft:${draft.callId}`,
      tainted: true,
      surface: "feed" as const,
    }),
    [draft.threadId, draft.callId],
  );
  return (
    <section
      aria-label={draft.title ?? t("widgets.frame.building")}
      aria-busy="true"
      data-testid="widget-draft"
      className="my-2 overflow-clip rounded-lg border border-border bg-background text-label-primary [contain:layout_paint]"
    >
      <header className="flex min-w-0 items-center gap-2 border-border border-b px-3 py-1.5 text-callout text-label-secondary">
        <LayoutPanelTop className="size-3.5 shrink-0" aria-hidden="true" />
        <h3 className="min-w-0 flex-1 truncate font-medium text-label-primary">
          {draft.title ?? t("widgets.frame.building")}
        </h3>
        <span data-testid="widget-state">{t("widgets.frame.building")}</span>
      </header>
      <div className="px-3 py-2.5">
        {draft.root === null ? null : (
          <WidgetContext.Provider value={ctx}>
            <RenderNode node={draft.root as never} depth={0} />
          </WidgetContext.Provider>
        )}
        <div className="mt-2 space-y-2" aria-hidden="true" data-testid="widget-draft-skeleton">
          <div className="h-3 w-3/4 rounded bg-fill-quaternary motion-safe:animate-pulse" />
          <div className="h-3 w-1/2 rounded bg-fill-quaternary motion-safe:animate-pulse" />
        </div>
      </div>
    </section>
  );
}
