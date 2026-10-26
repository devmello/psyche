import type { MouseEvent } from "react";
import { smoothScrollBehavior } from "../lib/reduced-motion.ts";
import type { OverviewPeriod } from "./period.ts";
import { type RecentFilter, recentHref, scrollToRecent } from "./recentFilter.ts";

/** An anchor's `href` plus the click that follows it inside the app. */
export interface OverviewLink {
  href: string;
  onClick: (event: MouseEvent<HTMLElement>) => void;
}

const plainClick = (e: MouseEvent<HTMLElement>): boolean =>
  e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/** Navigates in-app, then runs `then` once the route has rendered. */
export function go(href: string, onNavigate: (to: string) => void, then?: () => void): void {
  onNavigate(href);
  if (then !== undefined) requestAnimationFrame(then);
}

/**
 * A link to a route. With `onNavigate` a plain click is handled in-app; without it (a story, a
 * test, a bare web page) the `href` works as an ordinary link. `then` runs after navigating.
 */
export function routeLink(
  href: string,
  onNavigate: ((to: string) => void) | undefined,
  then?: () => void,
): OverviewLink {
  return {
    href,
    onClick: (e) => {
      if (onNavigate === undefined || !plainClick(e)) return;
      e.preventDefault();
      go(href, onNavigate, then);
    },
  };
}

/** A link to Recent runs filtered by `filter` (see `recentFilter.ts`). */
export const recentLink = (
  period: OverviewPeriod,
  filter: Partial<RecentFilter>,
  onNavigate: ((to: string) => void) | undefined,
): OverviewLink => routeLink(recentHref(period, filter), onNavigate, scrollToRecent);

/** A link to a section of this page (`#growth`): scrolls, no navigation. */
export function sectionLink(id: string): OverviewLink {
  return {
    href: `#${id}`,
    onClick: (e) => {
      if (!plainClick(e)) return;
      e.preventDefault();
      document
        .getElementById(id)
        ?.scrollIntoView({ behavior: smoothScrollBehavior(), block: "start" });
    },
  };
}
