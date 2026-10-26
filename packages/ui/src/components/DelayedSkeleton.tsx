import type { ReactElement } from "react";
import { cn } from "../lib/utils.ts";
import { useDelayedFlag } from "./page.tsx";
import { Skeleton } from "./ui/skeleton.tsx";

/**
 * The one skeleton for a single loading block (smoothness-2026 §3.3): the slot keeps its size from
 * the first frame, the shimmer appears only after `duration.skeletonDelay` and fades in. Pass the
 * final size in `className`.
 */
export function DelayedSkeleton({
  label,
  className,
}: {
  label: string;
  className?: string;
}): ReactElement {
  const shown = useDelayedFlag(true);
  return (
    <div className={cn("my-2 h-12 max-w-md", className)} role="status" aria-label={label}>
      <Skeleton
        data-testid="delayed-skeleton"
        className={cn(
          "size-full rounded-lg transition-opacity duration-(--duration-short) ease-(--ease-standard)",
          shown ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}
