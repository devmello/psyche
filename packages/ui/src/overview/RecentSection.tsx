import type { RunSummary } from "@psyche/protocol";
import { Search } from "lucide-react";
import { type ReactElement, useMemo, useState } from "react";
import { RecentRunRow } from "../agent/MissionControl.tsx";
import { runTitle } from "../agent/timeline/RunHeader.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.tsx";
import { useThreads } from "../data/index.ts";
import { useStore, useStoreState } from "../data/provider.tsx";
import { useRunsList } from "../data/runs.ts";
import { t } from "../i18n/core.ts";
import { useNow } from "../lib/use-now.ts";
import { useSlots } from "../slots.tsx";
import { OverviewSection } from "./OverviewSection.tsx";
import {
  DEFAULT_RECENT_FILTER,
  overviewRunHref,
  RECENT_FILTERS,
  type RecentFilter,
  recentRunsQuery,
} from "./recent.ts";

const FILTER_LABEL = {
  all: "agent.activity.filterAll",
  failed: "agent.activity.filterFailed",
  automation: "agent.activity.filterAutomations",
  chat: "agent.activity.filterChat",
} as const satisfies Record<RecentFilter, string>;

const PAGE = 25;

export interface RecentSectionProps {
  /** The filter in the route (`?filter=`). Without it the section keeps its own. */
  filter?: RecentFilter;
  onFilterChange?: (filter: RecentFilter) => void;
  now?: number;
}

/**
 * Recent runs (agent-overview-2026 §5.4): finished runs, newest first, filtered All / Failed /
 * Automations / Chat and searched by title, cursor-paged through `runs.list`. Rows open the
 * Timeline at `/overview/run/<id>`.
 */
export function RecentSection({
  filter: routed,
  onFilterChange,
  now: fixedNow,
}: RecentSectionProps): ReactElement {
  const [local, setLocal] = useState<RecentFilter>(DEFAULT_RECENT_FILTER);
  const filter = routed ?? local;
  const setFilter = (next: RecentFilter) => {
    setLocal(next);
    onFilterChange?.(next);
  };
  const [query, setQuery] = useState("");
  return (
    <OverviewSection id="recent">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 px-2">
          <ToggleGroup
            aria-label={t("agent.activity.recentFilter")}
            value={[filter]}
            onValueChange={(v) => {
              const next = RECENT_FILTERS.find((f) => f === v[0]);
              if (next !== undefined) setFilter(next);
            }}
          >
            {RECENT_FILTERS.map((f) => (
              <ToggleGroupItem key={f} value={f} size="sm">
                {t(FILTER_LABEL[f])}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="relative min-w-32 flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-label-tertiary"
            />
            <Input
              type="search"
              aria-label={t("agent.activity.search")}
              placeholder={t("agent.activity.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-7 ps-7 text-callout"
            />
          </div>
        </div>
        {/* A new filter is a new list: its pages start over. */}
        <RecentList key={filter} filter={filter} query={query} now={fixedNow} />
      </div>
    </OverviewSection>
  );
}

function RecentList({
  filter,
  query,
  now: fixedNow,
}: {
  filter: RecentFilter;
  query: string;
  now: number | undefined;
}): ReactElement {
  const now = useNow(30_000, fixedNow);
  const navigate = useSlots().navigate;
  const store = useStore();
  const params = useMemo(() => ({ ...recentRunsQuery(filter), limit: PAGE }), [filter]);
  const first = useRunsList(params);
  // Pages after the first come straight from `runs.list`; the first stays live.
  const [more, setMore] = useState<{
    runs: readonly RunSummary[];
    cursor: string | null | undefined;
    loading: boolean;
    error: string | null;
  }>({ runs: [], cursor: undefined, loading: false, error: null });
  useThreads();
  const threads = useStoreState((s) => s.threads);
  const title = (r: RunSummary) => runTitle(r, threads[r.threadId]?.thread.title);

  const cursor = more.cursor === undefined ? first.nextCursor : more.cursor;
  const loadMore = async () => {
    if (cursor === null) return;
    setMore((m) => ({ ...m, loading: true, error: null }));
    try {
      const res = await store.call("runs.list", { ...params, cursor });
      setMore((m) => ({
        runs: [...m.runs, ...res.runs],
        cursor: res.nextCursor ?? null,
        loading: false,
        error: null,
      }));
    } catch (err) {
      setMore((m) => ({
        ...m,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const needle = query.trim().toLowerCase();
  const seen = new Set<string>();
  const rows = [...first.runs, ...more.runs]
    .filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return r.parentRunId == null;
    })
    .filter((r) => title(r).toLowerCase().includes(needle));

  if (first.loading && first.runs.length === 0) {
    return (
      <div
        className="flex flex-col gap-1 px-2"
        role="status"
        aria-label={t("agent.activity.loading")}
      >
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  }
  if (first.error && first.runs.length === 0) {
    return (
      <p className="px-2 text-body">
        {t("agent.activity.loadFailed", { reason: first.error })}{" "}
        <button type="button" className="text-accent-11 underline" onClick={first.reload}>
          {t("agent.activity.tryAgain")}
        </button>
      </p>
    );
  }
  return (
    <>
      {rows.length === 0 ? (
        <p className="px-2 py-2 text-body text-label-secondary">
          {needle || filter !== DEFAULT_RECENT_FILTER
            ? t("agent.activity.noMatches")
            : t("agent.activity.noRecent")}
        </p>
      ) : (
        <ul className="flex flex-col" data-testid="overview-recent-list">
          {rows.map((r) => (
            <li key={r.id}>
              <RecentRunRow
                run={r}
                title={title(r)}
                now={now}
                onOpenRun={(id) => navigate?.(overviewRunHref(id))}
              />
            </li>
          ))}
        </ul>
      )}
      {more.error ? (
        <p className="px-2 text-callout text-danger-text" role="alert">
          {t("agent.activity.loadFailed", { reason: more.error })}
        </p>
      ) : null}
      {cursor !== null ? (
        <div className="px-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={more.loading}
            onClick={() => void loadMore()}
          >
            {t("overview.recent.more")}
          </Button>
        </div>
      ) : null}
    </>
  );
}
