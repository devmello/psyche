import { CircleAlert } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { cn } from "../../lib/utils.ts";

/**
 * Shared screen states for the proactive and content screens (UI design §3.0, §4.13): a header,
 * an empty state (one sentence plus one action), an error (what failed, what Psyche did, one next
 * step) and content-shaped skeletons that appear after 150 ms.
 */

/** True once `flag` has stayed true for `delayMs` (skeletons appear after 150 ms, §3.0). */
export function useDelayedFlag(flag: boolean, delayMs = 150): boolean {
  const [shown, setShown] = useState(flag && delayMs === 0);
  useEffect(() => {
    if (!flag) {
      setShown(false);
      return;
    }
    if (delayMs === 0) {
      setShown(true);
      return;
    }
    const t = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(t);
  }, [flag, delayMs]);
  return shown;
}

export interface ScreenHeaderProps {
  title: string;
  /** Short facts after the title, e.g. "Today · 7 posts". */
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function ScreenHeader({ title, meta, actions, className }: ScreenHeaderProps): ReactElement {
  return (
    <header className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)}>
      <h1 className="text-2xl font-semibold">{title}</h1>
      {meta ? <p className="text-sm text-muted-foreground">{meta}</p> : null}
      {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export interface EmptyStateProps {
  /** One sentence in Psyche's voice. */
  children: ReactNode;
  /** The one action. */
  action?: { label: string; onClick: () => void };
  className?: string;
}

export function EmptyState({ children, action, className }: EmptyStateProps): ReactElement {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-dashed border-gray-6 px-6 py-10 text-center",
        className,
      )}
    >
      <p className="text-base text-gray-11">{children}</p>
      {action ? (
        <Button type="button" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

export interface ErrorStateProps {
  /** What failed, e.g. "Psyche couldn't load the feed". */
  what: string;
  /** The underlying reason, shown in parentheses. */
  reason?: string | null;
  /** What Psyche did, e.g. "Nothing was changed." */
  did?: string;
  /** The one next step. */
  retry?: { label?: string; onClick: () => void };
  className?: string;
}

export function ErrorState({
  what,
  reason,
  did = "Nothing was changed.",
  retry,
  className,
}: ErrorStateProps): ReactElement {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-start gap-3 rounded-lg border border-gray-6 bg-gray-2 p-4 text-sm",
        className,
      )}
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger-text" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">
          {what}
          {reason ? ` (${reason})` : ""}.
        </span>{" "}
        {did}
      </p>
      {retry ? (
        <Button type="button" size="sm" variant="outline" onClick={retry.onClick}>
          {retry.label ?? "Try again"}
        </Button>
      ) : null}
    </div>
  );
}

export interface LoadingCardsProps {
  /** Announced to assistive tech, e.g. "Loading the feed". */
  label: string;
  count?: number;
  /** Lines per card. */
  lines?: number;
  layout?: "stack" | "grid" | "rows";
  className?: string;
}

/** Skeletons in the shape of the content (§3.0). */
export function LoadingCards({
  label,
  count = 3,
  lines = 3,
  layout = "stack",
  className,
}: LoadingCardsProps): ReactElement {
  return (
    <div
      role="status"
      aria-busy="true"
      className={cn(
        layout === "grid" ? "grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3" : "",
        layout === "stack" ? "flex flex-col gap-3" : "",
        layout === "rows" ? "flex flex-col gap-1" : "",
        className,
      )}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders never reorder
          key={i}
          className={cn(
            "flex flex-col gap-2",
            layout === "rows" ? "py-2" : "rounded-lg border border-gray-6 bg-gray-2 p-4",
          )}
        >
          <Skeleton className="h-3 w-24" />
          {Array.from({ length: lines }, (_, j) => (
            <Skeleton
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders never reorder
              key={j}
              className={cn("h-3", j === lines - 1 ? "w-2/3" : "w-full")}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
