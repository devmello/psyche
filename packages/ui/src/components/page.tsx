import { CircleAlert, type LucideIcon } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";
import { Skeleton } from "./ui/skeleton.tsx";

/**
 * Page layout and shared screen states (UI design §3.0, §4.1–§4.4, §4.13): the page column, its
 * header, section labels, an empty state (one sentence plus one action), an error (what failed,
 * what Psyche did, one next step) and content-shaped skeletons that appear after 150 ms. Every
 * screen uses these so headers, gutters and states look the same everywhere.
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

export interface PageProps {
  children: ReactNode;
  /** "prose" for reading columns (68ch), "wide" for lists and grids, "full" for split views. */
  width?: "prose" | "wide" | "full";
  className?: string;
}

/** The scrolling page column every rail screen sits in: centred, 24 px gutters, 24 px rhythm. */
export function Page({ children, width = "wide", className }: PageProps): ReactElement {
  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col gap-6 px-6 pt-6 pb-12",
        width === "prose" && "max-w-[calc(var(--prose-width)+3rem)]",
        width === "wide" && "max-w-[calc(var(--page-width)+3rem)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface ScreenHeaderProps {
  title: string;
  /** Short facts after the title, e.g. "Today · 7 posts". */
  meta?: ReactNode;
  /** One sentence under the title. */
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** A page's h1 with its facts, one-line description and actions (§4.2: h1 24/30 at 600). */
export function PageHeader({
  title,
  meta,
  description,
  actions,
  className,
}: ScreenHeaderProps): ReactElement {
  return (
    <header className={cn("flex flex-wrap items-end gap-x-3 gap-y-2", className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-h1 text-foreground">{title}</h1>
          {meta ? <p className="text-small text-muted-foreground">{meta}</p> : null}
        </div>
        {description ? <p className="text-small text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Kept for the screens that predate `PageHeader`. */
export const ScreenHeader = PageHeader;

/** An uppercase group label (§4.2 label 11/14), e.g. "HEALTH" or "NEEDS YOU (2)". */
export function SectionLabel({
  children,
  className,
  as: Tag = "h2",
  id,
}: {
  children: ReactNode;
  className?: string;
  as?: "h2" | "h3" | "p" | "span";
  id?: string;
}): ReactElement {
  return (
    <Tag id={id} className={cn("text-label text-gray-11", className)}>
      {children}
    </Tag>
  );
}

export interface EmptyStateProps {
  /** One sentence in Psyche's voice. */
  children: ReactNode;
  /** The one action. */
  action?: { label: string; onClick: () => void };
  /** A Lucide icon for the screen, shown in a soft circle above the sentence. */
  icon?: LucideIcon;
  className?: string;
}

export function EmptyState({
  children,
  action,
  icon: Icon,
  className,
}: EmptyStateProps): ReactElement {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 px-6 pt-[12vh] pb-14 text-center animate-psy-fade",
        className,
      )}
    >
      {Icon ? <Icon className="size-8 text-label-tertiary" aria-hidden="true" /> : null}
      <p className="max-w-sm text-reading text-label-secondary">{children}</p>
      {action ? (
        <Button type="button" variant="outline" onClick={action.onClick}>
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
        "flex flex-wrap items-start gap-3 rounded-lg bg-surface-raised p-4 text-body shadow-elevation-1",
        className,
      )}
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger-text" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-label-secondary">
        <span className="font-semibold text-label-primary">
          {what}
          {reason ? ` (${reason})` : ""}.
        </span>{" "}
        {did}
      </p>
      {retry ? (
        <Button type="button" size="sm" variant="outline" onClick={retry.onClick}>
          {retry.label ?? t("common.tryAgain")}
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
            layout === "rows" ? "py-2" : "rounded-lg bg-surface-raised p-4 shadow-elevation-1",
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

export interface GroupedListProps {
  /** Group header (text-title-3), e.g. "Default mode for new threads". */
  title?: ReactNode;
  /** Help text under the group (text-callout). */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * A grouped inset list (docs/design/redesign-2026.md §5.8, System Settings style): a raised,
 * borderless container whose rows are separated by hairlines inset to the text start.
 */
export function GroupedList({
  title,
  footer,
  children,
  className,
}: GroupedListProps): ReactElement {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      {title ? <h3 className="px-1 text-title-3 text-label-primary">{title}</h3> : null}
      <div className="flex flex-col rounded-lg bg-surface-raised shadow-elevation-1">
        {children}
      </div>
      {footer ? <p className="px-1 text-callout text-label-secondary">{footer}</p> : null}
    </section>
  );
}

export interface GroupedRowProps {
  label: ReactNode;
  /** A secondary line under the label. */
  description?: ReactNode;
  /** A leading icon or avatar. */
  leading?: ReactNode;
  /** The trailing control (switch, select, segmented control, value). */
  control?: ReactNode;
  className?: string;
}

/** A 36 px row in a `GroupedList`: label leading, control trailing. */
export function GroupedRow({
  label,
  description,
  leading,
  control,
  className,
}: GroupedRowProps): ReactElement {
  return (
    <div
      className={cn(
        "relative flex min-h-9 items-center gap-3 px-3 py-1.5 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator first:before:hidden",
        className,
      )}
    >
      {leading ? (
        <span className="flex shrink-0 items-center text-label-secondary">{leading}</span>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-body text-label-primary">{label}</span>
        {description ? (
          <span className="text-callout text-label-secondary">{description}</span>
        ) : null}
      </div>
      {control ? <div className="flex shrink-0 items-center gap-2">{control}</div> : null}
    </div>
  );
}
