import type { RunSummary } from "@psyche/protocol";
import { Search, X } from "lucide-react";
import { type ReactElement, useMemo, useRef, useState } from "react";
import { RecentRunRow } from "../agent/MissionControl.tsx";
import { runTitle } from "../agent/timeline/RunHeader.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.tsx";
import { useThreads } from "../data/index.ts";
import { useStore, useStoreState } from "../data/provider.tsx";
import { useRunsList } from "../data/runs.ts";
import { activeI18n, t } from "../i18n/core.ts";
import { useNow } from "../lib/use-now.ts";
import { cn } from "../lib/utils.ts";
import { useSlots } from "../slots.tsx";
import { OverviewSection } from "./OverviewSection.tsx";
import type { OverviewPeriod } from "./period.ts";
import { matchesRecent, overviewRunHref, recentRunsQuery } from "./recent.ts";
import {
  NO_RECENT_FILTER,
  parseRecentFilter,
  type RecentFilter,
  type RecentFilterKind,
  recentHref,
} from "./recentFilter.ts";
import {
  DIM_WHILE_REVALIDATING,
  SectionBody,
  SkeletonRows,
  useSectionStatus,
} from "./SectionState.tsx";

const FILTER_LABEL = {
  all: "agent.activity.filterAll",
  tasks: "overview.recent.filterTasks",
  automations: "agent.activity.filterAutomations",
  chat: "agent.activity.filterChat",
  failed: "agent.activity.filterFailed",
} as const satisfies Record<RecentFilterKind, string>;

/** The four chips of the spec; Tasks (the summary tile's link) shows only while it is chosen. */
const CHIPS: readonly RecentFilterKind[] = ["all", "failed", "automations", "chat"];
const CHIPS_WITH_TASKS: readonly RecentFilterKind[] = [
  "all",
  "tasks",
  "failed",
  "automations",
  "chat",
];

const PAGE = 25;

export interface RecentSectionProps {
  period: OverviewPeriod;
  /** The current route: its `?filter=` and `?day=` are the filter (`recentFilter.ts`, O4). */
  route?: string;
  /** The shell's `navigate`. Without it (a story, a test) the section keeps its filter itself. */
  onNavigate?: ((to: string) => void) | undefined;
  now?: number | undefined;
}

/**
 * Recent runs (agent-overview-2026 §5.4): finished runs in the period, newest first, filtered
 * All / Failed / Automations / Chat (and Tasks or one day when a tile or bar linked here), searched
 * by title and cursor-paged through `runs.list`. Rows open the Timeline at `/overview/run/<id>`.
 */
export function RecentSection({
  period,
  route,
  onNavigate,
  now: fixedNow,
}: RecentSectionProps): ReactElement {
  const [local, setLocal] = useState<RecentFilter>(() => parseRecentFilter(route ?? ""));
  const filter = onNavigate === undefined ? local : parseRecentFilter(route ?? "");
  const setFilter = (next: RecentFilter) => {
    if (onNavigate === undefined) setLocal(next);
    else onNavigate(recentHref(period, next));
  };
  const [query, setQuery] = useState("");
  const i18n = activeI18n();
  const chips = filter.filter === "tasks" ? CHIPS_WITH_TASKS : CHIPS;
  return (
    <OverviewSection id="recent">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 px-2">
          <ToggleGroup
            aria-label={t("agent.activity.recentFilter")}
            value={[filter.filter]}
            onValueChange={(v) => {
              const next = chips.find((f) => f === v[0]);
              if (next !== undefined) setFilter({ filter: next, status: null, day: filter.day });
            }}
          >
            {chips.map((f) => (
              <ToggleGroupItem key={f} value={f} size="sm">
                {t(FILTER_LABEL[f])}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {filter.day !== null ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                setFilter({ ...NO_RECENT_FILTER, filter: filter.filter, status: filter.status })
              }
              aria-label={t("overview.recent.clearDay", { date: filter.day })}
            >
              {i18n.date(`${filter.day}T12:00:00Z`, {
                month: "short",
                day: "numeric",
                timeZone: "UTC",
              })}
              <X aria-hidden="true" />
            </Button>
          ) : null}
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
        <RecentList
          key={`${period}|${filter.filter}|${filter.day ?? ""}`}
          period={period}
          filter={filter}
          query={query}
          now={fixedNow}
        />
      </div>
    </OverviewSection>
  );
}

function RecentList({
  period,
  filter,
  query,
  now: fixedNow,
}: {
  period: OverviewPeriod;
  filter: RecentFilter;
  query: string;
  now: number | undefined;
}): ReactElement {
  const now = useNow(30_000, fixedNow);
  const navigate = useSlots().navigate;
  const store = useStore();
  // The window is read once per list, so a ticking clock never re-queries.
  const [asked] = useState(() => now);
  const params = useMemo(
    () => ({ ...recentRunsQuery(period, filter, asked), limit: PAGE }),
    [period, filter, asked],
  );
  const first = useRunsList(params);
  const status = useSectionStatus("recent", [{ ...first, key: JSON.stringify(params) }]);
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
  const timeZone = activeI18n().timeZone;

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
    .filter((r) => matchesRecent(r, filter, timeZone))
    .filter((r) => title(r).toLowerCase().includes(needle));

  // A new window or filter keeps the previous rows up, dimmed, until its own arrive.
  const lastRows = useRef<readonly RunSummary[]>(rows);
  if (!status.revalidating) lastRows.current = rows;
  const shown = status.revalidating ? lastRows.current : rows;
  const dim = DIM_WHILE_REVALIDATING;
  if (status.phase !== "ready") {
    return (
      <div className="px-2">
        <SectionBody
          id="recent"
          status={status}
          reserve="min-h-24"
          skeleton={<SkeletonRows count={3} />}
        >
          {null}
        </SectionBody>
      </div>
    );
  }
  const unfiltered = filter.filter === "all" && filter.day === null && needle === "";
  return (
    <>
      {shown.length === 0 ? (
        <p
          className={cn("px-2 py-2 text-body text-label-secondary", dim)}
          data-revalidating={status.revalidating ? "true" : "false"}
        >
          {unfiltered ? t("agent.activity.noRecent") : t("agent.activity.noMatches")}
        </p>
      ) : (
        <ul
          className={cn("flex flex-col", dim)}
          data-testid="overview-recent-list"
          data-revalidating={status.revalidating ? "true" : "false"}
          aria-busy={status.revalidating ? "true" : undefined}
        >
          {shown.map((r) => (
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
