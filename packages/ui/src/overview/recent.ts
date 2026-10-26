import type { RunsFilter } from "../data/runs.ts";

/**
 * The Recent runs filter (agent-overview-2026 §5.4), held in the route as `?filter=` so a link
 * reproduces the list: `/overview?filter=failed`. `all` leaves the URL clean.
 */
export const RECENT_FILTERS = ["all", "failed", "automation", "chat"] as const;
export type RecentFilter = (typeof RECENT_FILTERS)[number];
export const DEFAULT_RECENT_FILTER: RecentFilter = "all";

/** `?filter=` from a route or query string; anything unknown is `all`. */
export function parseRecentFilter(routeOrQuery: string): RecentFilter {
  const query = routeOrQuery.includes("?") ? (routeOrQuery.split("?")[1] ?? "") : routeOrQuery;
  const raw = new URLSearchParams(query.split("#")[0]).get("filter");
  return RECENT_FILTERS.find((f) => f === raw) ?? DEFAULT_RECENT_FILTER;
}

/** `href` with the filter set (or cleared for `all`), keeping its other query and its hash. */
export function withRecentFilter(href: string, filter: RecentFilter): string {
  const [rest = "", hash] = href.split("#");
  const [path = "", search = ""] = rest.split("?");
  const query = new URLSearchParams(search);
  if (filter === DEFAULT_RECENT_FILTER) query.delete("filter");
  else query.set("filter", filter);
  const qs = query.toString();
  return `${path}${qs ? `?${qs}` : ""}${hash === undefined ? "" : `#${hash}`}`;
}

/** The `runs.list` params for a filter: finished runs, narrowed by outcome or kind. */
export function recentRunsQuery(filter: RecentFilter): RunsFilter {
  switch (filter) {
    case "failed":
      return { status: ["failed"] };
    case "automation":
      return { status: ["done", "failed", "cancelled"], kind: "automation" };
    case "chat":
      return { status: ["done", "failed", "cancelled"], kind: "chat" };
    default:
      return { status: ["done", "failed", "cancelled"] };
  }
}

/** `/overview/run/<runId>[?step=<stepId>]`: a run's Timeline at full width (§3). */
export function overviewRunHref(runId: string, options: { stepId?: string } = {}): string {
  const base = `/overview/run/${encodeURIComponent(runId)}`;
  return options.stepId ? `${base}?step=${encodeURIComponent(options.stepId)}` : base;
}

/** The section anchor in a route (`/overview#upcoming`), when it names one. */
export function overviewAnchor(route: string): string | undefined {
  const hash = route.split("#")[1];
  return hash && /^[a-z]+$/.test(hash) ? hash : undefined;
}
