import type { ReactElement } from "react";
import { useDelayedFlag } from "../components/page.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { t } from "../i18n/core.ts";
import { FadeIn, Presence } from "../motion/index.ts";

/**
 * What a thread shows while its first page of messages loads (smoothness-2026 C2): nothing for
 * `duration.skeletonDelay`, then message-shaped bars that fade in and out. The slot keeps its
 * height from the first frame so the conversation does not jump when it arrives.
 */
export function TranscriptSkeleton({ loading }: { loading: boolean }): ReactElement | null {
  const shown = useDelayedFlag(loading);
  if (!loading) return null;
  return (
    <div
      className="flex min-h-[320px] flex-col justify-end gap-6 pb-2"
      data-testid="transcript-skeleton-slot"
      aria-busy="true"
    >
      <Presence initial={false}>
        {shown ? (
          <FadeIn
            still
            key="bars"
            className="flex flex-col gap-6"
            data-testid="transcript-skeleton"
            role="status"
            aria-label={t("chat.thread.loading")}
          >
            <Skeleton className="h-9 w-3/5 self-end rounded-2xl" />
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-11/12" />
              <Skeleton className="h-4 w-2/3" />
            </div>
            <Skeleton className="h-9 w-2/5 self-end rounded-2xl" />
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          </FadeIn>
        ) : null}
      </Presence>
    </div>
  );
}
