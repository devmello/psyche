import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useDelayedFlag } from "../components/page.tsx";
import { Button } from "../components/ui/button.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { type OverviewSectionId, sectionTitle } from "./OverviewSection.tsx";

/**
 * Loading, error and stale states shared by every Overview section (agent-overview-2026 §5.5,
 * smoothness-2026 C4): a section is never "empty" before its data arrived, a skeleton shaped
 * like the section appears only after 150 ms (into space that is already reserved), a failed
 * section says so and retries on its own, and a refetch that fails keeps the old data on screen
 * and tells the toolbar ("Last updated 10:42").
 */

/** What a section reads from a data hook. `has` and `key` are for keyed queries (the period). */
export interface SectionLoad {
  loading: boolean;
  error: string | null;
  reload: () => void;
  /** True when the hook holds data for the current key (a `useGatewayQuery` result). */
  has?: boolean;
  /** Changes when the hook asks for something else; the "loaded once" latch starts over. */
  key?: string;
}

/** Dims what an element with `data-revalidating="true"` shows, after the skeleton delay. */
export const DIM_WHILE_REVALIDATING =
  "transition-opacity duration-short ease-standard motion-reduce:transition-none data-[revalidating=true]:opacity-60 data-[revalidating=true]:delay-150";

export type SectionPhase = "loading" | "error" | "ready";

export interface SectionStatus {
  phase: SectionPhase;
  /** Data is showing but the latest refetch failed. */
  stale: boolean;
  /**
   * The key changed and the new data is on its way: the section keeps showing what it last had
   * (via `useLastDefined`), dimmed, instead of falling back to a skeleton.
   */
  revalidating: boolean;
  reload: () => void;
}

/**
 * The last value that was defined: while a keyed query has no data yet for its new key, a
 * section keeps rendering the previous key's data (stale-while-revalidate).
 */
export function useLastDefined<T>(value: T | undefined): T | undefined {
  const last = useRef<T | undefined>(value);
  if (value !== undefined) last.current = value;
  return value ?? last.current;
}

// --- Stale reporting to the toolbar ---------------------------------------------------------

interface Report {
  stale: boolean;
  /** Epoch ms of the last time the section was seen up to date. */
  freshAt: number;
}

interface OverviewStatusValue {
  report: (id: string, report: Report | null) => void;
}

const StatusContext = createContext<OverviewStatusValue | null>(null);
export const OverviewStatusProvider = StatusContext.Provider;

/** Collects which sections are stale so the screen can show one "Last updated" note. */
export function useOverviewStatusProvider(): {
  value: OverviewStatusValue;
  /** Epoch ms the oldest stale section was last fresh, or null when nothing is stale. */
  staleSince: number | null;
} {
  const [reports, setReports] = useState<Readonly<Record<string, Report>>>({});
  const report = useCallback((id: string, next: Report | null) => {
    setReports((prev) => {
      const had = prev[id];
      if (next === null) {
        if (had === undefined) return prev;
        const { [id]: _gone, ...rest } = prev;
        return rest;
      }
      if (had !== undefined && had.stale === next.stale && had.freshAt === next.freshAt) {
        return prev;
      }
      return { ...prev, [id]: next };
    });
  }, []);
  const staleSince = useMemo(() => {
    const stale = Object.values(reports).filter((r) => r.stale);
    return stale.length === 0 ? null : Math.min(...stale.map((r) => r.freshAt));
  }, [reports]);
  const value = useMemo(() => ({ report }), [report]);
  return { value, staleSince };
}

// --- The status hook ------------------------------------------------------------------------

/**
 * Folds one or more data hooks into a section's phase. A load is "ready" when it holds data
 * for its key (`has`) or has finished once without error for that key, so a background refetch
 * (`loading` flips back to true) never swaps content for a skeleton, and a failed refetch is
 * `stale`, not `error`.
 */
export function useSectionStatus(
  id: OverviewSectionId | "summary",
  loads: SectionLoad[],
): SectionStatus {
  const okKeys = useRef<(string | undefined)[]>([]);
  loads.forEach((l, i) => {
    if (!l.loading && l.error === null && l.has !== false) okKeys.current[i] = l.key ?? "";
  });
  const ready = loads.map((l, i) => l.has === true || okKeys.current[i] === (l.key ?? ""));
  const allReady = ready.every(Boolean);
  const stale = allReady && loads.some((l) => l.error !== null);
  // Once every load was ready, a key change keeps the section's last content up while it loads.
  const wasReady = useRef(false);
  if (allReady) wasReady.current = true;
  let phase: SectionPhase = "ready";
  let revalidating = false;
  if (!allReady) {
    const pending = loads.filter((_, i) => !ready[i]);
    const settledWithError =
      pending.some((l) => l.error !== null) && pending.every((l) => !l.loading);
    if (settledWithError) phase = "error";
    else if (wasReady.current) revalidating = true;
    else phase = "loading";
  }
  const latest = useRef(loads);
  latest.current = loads;
  const reload = useCallback(() => {
    for (const l of latest.current) if (l.error !== null || l.has === false) l.reload();
  }, []);

  // Tell the toolbar when this section is showing old data, and since when it was fresh.
  const status = useContext(StatusContext);
  const freshAt = useRef(Date.now());
  if (phase === "ready" && !stale) freshAt.current = Date.now();
  const lastFresh = freshAt.current;
  const report = status?.report;
  useEffect(() => {
    report?.(id, stale ? { stale: true, freshAt: lastFresh } : null);
    return () => report?.(id, null);
  }, [report, id, stale, lastFresh]);

  return { phase, stale, revalidating, reload };
}

// --- Components -----------------------------------------------------------------------------

export interface DelayedSkeletonProps {
  /** What is loading, for the live region ("Loading Growth"). */
  label: string;
  testId?: string;
  className?: string;
  children: ReactNode;
}

/**
 * A skeleton that takes its space from frame 0 but stays invisible for 150 ms
 * (`duration.skeletonDelay`), so data arriving quickly never flashes it. It fades in over the
 * short duration; under reduced motion the shimmer stops (design.css) and the fade is instant.
 */
export function DelayedSkeleton({
  label,
  testId,
  className,
  children,
}: DelayedSkeletonProps): ReactElement {
  const shown = useDelayedFlag(true);
  return (
    <div
      {...(shown ? { role: "status", "aria-label": label } : { "aria-hidden": true })}
      aria-busy="true"
      data-shown={shown ? "true" : "false"}
      data-testid={testId}
      className={cn(
        "transition-opacity duration-short ease-standard motion-reduce:transition-none",
        shown ? "opacity-100" : "opacity-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The section-level failure: "Couldn’t load Growth · Retry". Only this section fails (§5.5). */
export function LoadFailed({
  onRetry,
  section,
}: {
  onRetry: (() => void) | undefined;
  section?: OverviewSectionId;
}): ReactElement {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 text-callout text-label-secondary"
      data-testid="overview-load-failed"
    >
      <span>
        {section === undefined
          ? t("overview.error.load")
          : t("overview.error.section", { section: sectionTitle(section) })}
      </span>
      {onRetry === undefined ? null : (
        <>
          <span aria-hidden="true">·</span>
          <Button size="sm" variant="ghost" onClick={onRetry}>
            {t("common.retry")}
          </Button>
        </>
      )}
    </div>
  );
}

export interface SectionBodyProps {
  id: OverviewSectionId;
  status: SectionStatus;
  /** The skeleton's shape (rows and blocks); it holds the section's loaded height. */
  skeleton: ReactNode;
  /** Min-height classes that hold the section's loaded height while its skeleton is up. */
  reserve?: string;
  /** Rendered only once the data is there. */
  children: ReactNode;
}

/** The body of a section: its delayed skeleton, its error with Retry, or the content. */
export function SectionBody({
  id,
  status,
  skeleton,
  reserve,
  children,
}: SectionBodyProps): ReactElement {
  if (status.phase === "ready") {
    // Dimmed only after the skeleton delay, so a quick refetch never flickers.
    return (
      <div
        data-revalidating={status.revalidating ? "true" : "false"}
        aria-busy={status.revalidating ? "true" : undefined}
        className={DIM_WHILE_REVALIDATING}
      >
        {children}
      </div>
    );
  }
  if (status.phase === "error") {
    // Compact: a failed section is a line with Retry, not a blank card the height of its data.
    return <LoadFailed section={id} onRetry={status.reload} />;
  }
  return (
    <DelayedSkeleton
      label={t("overview.section.loading", { section: sectionTitle(id) })}
      testId={`overview-${id}-loading`}
      className={cn("flex flex-col gap-2", reserve)}
    >
      {skeleton}
    </DelayedSkeleton>
  );
}

/** Evenly spaced row placeholders (Now, Upcoming, Recent). */
export function SkeletonRows({
  count,
  className,
}: {
  count: number;
  className?: string;
}): ReactElement {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders never reorder
        <Skeleton key={i} className={cn("h-10", className)} />
      ))}
    </>
  );
}
