import type { ReactElement } from "react";
import { useDelayedFlag } from "../components/page.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { t } from "../i18n/core.ts";
import { FadeIn, Presence } from "../motion/index.ts";

/**
 * The canvas body while an artifact or its content loads (smoothness-2026 C5): the slot holds its
 * height from frame 0, content-shaped bars appear after `duration.skeletonDelay` and fade away
 * when the content arrives.
 */
export function CanvasSkeleton(): ReactElement {
  const shown = useDelayedFlag(true);
  return (
    <div className="min-h-[240px]" data-testid="canvas-skeleton-slot" aria-busy="true">
      <Presence initial={false}>
        {shown ? (
          <FadeIn
            still
            key="bars"
            className="flex flex-col gap-3"
            data-testid="canvas-skeleton"
            role="status"
            aria-label={t("canvas.loading")}
          >
            <Skeleton className="h-6 w-2/5" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="mt-2 h-24 w-full" />
          </FadeIn>
        ) : null}
      </Presence>
    </div>
  );
}
