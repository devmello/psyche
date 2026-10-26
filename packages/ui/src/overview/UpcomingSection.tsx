import type { Automation } from "@psyche/protocol";
import { ChevronRight } from "lucide-react";
import { type ReactElement, useState } from "react";
import { UpcomingRow, useUpcomingRowProps } from "../agent/UpcomingPanel.tsx";
import { activeI18n, t } from "../i18n/core.ts";
import { useNow } from "../lib/use-now.ts";
import { cn } from "../lib/utils.ts";
import { OverviewSection } from "./OverviewSection.tsx";
import { SectionBody, SkeletonRows, useSectionStatus } from "./SectionState.tsx";
import { groupUpcoming, UPCOMING_GROUPS, type UpcomingGroup } from "./upcoming-groups.ts";
import { useUpcomingEntries } from "./useUpcomingEntries.ts";

const GROUP_LABEL = {
  today: "overview.upcoming.today",
  tomorrow: "overview.upcoming.tomorrow",
  week: "overview.upcoming.week",
  later: "overview.upcoming.later",
} as const satisfies Record<UpcomingGroup, string>;

/**
 * Upcoming (agent-overview-2026 §5.4): enabled automations grouped by the day they next run.
 * Frequent ones ("every 45 min") are a single row that says so. Rows are the agent sheet's
 * `UpcomingRow` (usual run, pause, snooze, delete); paused automations sit under a disclosure.
 */
export function UpcomingSection({ now: fixedNow }: { now?: number }): ReactElement {
  const now = useNow(30_000, fixedNow);
  const { entries, paused, automations, loading, error, reload } = useUpcomingEntries();
  const rowProps = useUpcomingRowProps(automations, now);
  const [showPaused, setShowPaused] = useState(false);
  const groups = groupUpcoming(entries, now, activeI18n().timeZone);
  const row = (a: Automation) => (
    <UpcomingRow key={a.id} automation={a} now={now} {...rowProps(a)} />
  );

  const status = useSectionStatus("upcoming", [{ loading, error, reload, key: "upcoming" }]);
  let body: ReactElement;
  if (status.phase !== "ready") {
    body = (
      <SectionBody
        id="upcoming"
        status={status}
        reserve="min-h-24"
        skeleton={<SkeletonRows count={2} />}
      >
        {null}
      </SectionBody>
    );
  } else if (entries.length === 0 && paused.length === 0) {
    body = <p className="text-callout text-label-tertiary">{t("agent.upcoming.empty")}</p>;
  } else {
    body = (
      <div className="flex flex-col gap-3">
        {UPCOMING_GROUPS.map((g) => {
          const rows = groups[g].flatMap((e) => (e.automation ? [e.automation] : []));
          return rows.length === 0 ? null : (
            <section
              key={g}
              aria-label={t(GROUP_LABEL[g])}
              data-testid={`overview-upcoming-${g}`}
              className="flex flex-col"
            >
              <h4 className="text-caption text-label-secondary">{t(GROUP_LABEL[g])}</h4>
              <ul className="flex flex-col divide-y divide-separator">{rows.map(row)}</ul>
            </section>
          );
        })}
        {paused.length > 0 ? (
          <section className="flex flex-col" data-testid="overview-upcoming-paused">
            <button
              type="button"
              aria-expanded={showPaused}
              aria-controls="overview-upcoming-paused-list"
              onClick={() => setShowPaused((v) => !v)}
              className="flex w-fit items-center gap-1 rounded-sm text-caption text-label-secondary outline-none hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronRight
                aria-hidden="true"
                className={cn("size-3.5 rtl:-scale-x-100", showPaused && "rotate-90 rtl:rotate-90")}
              />
              {t("overview.upcoming.paused", { n: paused.length })}
            </button>
            {showPaused ? (
              <ul
                id="overview-upcoming-paused-list"
                className="flex flex-col divide-y divide-separator"
              >
                {paused.map(row)}
              </ul>
            ) : null}
          </section>
        ) : null}
      </div>
    );
  }
  return <OverviewSection id="upcoming">{body}</OverviewSection>;
}
