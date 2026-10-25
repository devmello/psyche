import type { ReactElement, ReactNode } from "react";
import { useToolbar, useToolbarContent } from "../../components/ui/toolbar.tsx";
import { cn } from "../../lib/utils.ts";

export interface ScreenToolbarProps {
  /** The page title (text-title-1). It is the page's only heading at level 1. */
  title: string;
  /** Short facts after the title, e.g. "Today · 7 posts" (text-callout, secondary). */
  meta?: ReactNode;
  /** Controls before the trailing group, e.g. Library's section switcher. */
  center?: ReactNode;
  /** Trailing controls: plain and ghost buttons, at most one prominent. */
  actions?: ReactNode;
  className?: string;
}

/**
 * A content screen's toolbar row (docs/design/redesign-2026.md §5.6): 52 px, the title in
 * text-title-1 at the leading edge and the actions trailing, so the title is not repeated in the
 * content. It sticks to the top of the scrolling page and fades the content under it with a
 * 24 px scroll-edge gradient instead of a border (§3.4).
 *
 * It registers the same content with the shell's toolbar (`useToolbar`, workstream A2). Inside a
 * `ToolbarProvider` the shell's `ToolbarSlot` shows it and this row renders nothing; outside one
 * (stories, tests, a shell without the slot yet) the screen draws the row itself.
 */
export function ScreenToolbar({
  title,
  meta,
  center,
  actions,
  className,
}: ScreenToolbarProps): ReactElement | null {
  useToolbar({
    title,
    ...(meta ? { subtitle: meta } : {}),
    ...(center || actions
      ? {
          trailing: (
            <>
              {center}
              {actions}
            </>
          ),
        }
      : {}),
  });
  // Non-null only when a provider is listening: the registration above is then its content.
  if (useToolbarContent() !== null) return null;
  return (
    <header
      data-slot="screen-toolbar"
      className={cn(
        "@container/toolbar sticky top-0 z-10 flex h-13 shrink-0 items-center gap-3 bg-canvas px-4 md:px-6",
        "after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-6 after:bg-linear-to-b after:from-canvas after:to-transparent",
        className,
      )}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <h1 className="shrink-0 text-title-1 text-label-primary">{title}</h1>
        {meta ? (
          <p className="truncate text-callout text-label-secondary @max-md/toolbar:hidden">
            {meta}
          </p>
        ) : null}
      </div>
      {center ? <div className="flex min-w-0 flex-1 justify-center">{center}</div> : null}
      {actions ? (
        <div className={cn("flex shrink-0 items-center gap-1", center ? "" : "ms-auto")}>
          {actions}
        </div>
      ) : null}
    </header>
  );
}

/**
 * A toolbar button's text: shown beside the icon, and spoken only (icon button) when the toolbar
 * is narrow (compact, §5.11).
 */
export function ToolbarLabel({ children }: { children: ReactNode }): ReactElement {
  return <span className="@max-md/toolbar:sr-only">{children}</span>;
}

/** The content column under the toolbar: 680 px for reading screens, 880 px for lists. */
export function ScreenColumn({
  width,
  children,
  className,
}: {
  width: "reading" | "wide";
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <div
      className={cn(
        "@container/column mx-auto flex w-full flex-col gap-3 px-4 pt-4 pb-12 md:px-6",
        width === "reading" ? "max-w-[calc(680px+3rem)]" : "max-w-[calc(880px+3rem)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
