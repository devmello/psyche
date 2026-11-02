import type { ReactElement } from "react";
import { useApprovalQueue } from "../agent/ApprovalsPanel.tsx";
import { NextRow, NowRunRow, Row } from "../agent/MissionControl.tsx";
import { runTitle } from "../agent/timeline/RunHeader.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { useQuestions, useRunsList, useThreads } from "../data/index.ts";
import { useStoreState } from "../data/provider.tsx";
import { t } from "../i18n/core.ts";
import { formatRelative } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { usePersona, useSlots } from "../slots.tsx";
import { OverviewSection } from "./OverviewSection.tsx";
import { overviewRunHref } from "./recent.ts";
import { SectionBody, useSectionStatus } from "./SectionState.tsx";
import { useUpcomingEntries } from "./useUpcomingEntries.ts";

/** How many scheduled things "Next up" shows; the Upcoming section has the rest (§5.4). */
const NEXT_UP = 3;

function Heading({ children }: { children: string }): ReactElement {
  return <h4 className="px-2 pb-0.5 text-caption text-label-secondary">{children}</h4>;
}

/** Two columns of heading and rows, like the loaded body, so nothing moves when data arrives. */
function NowSkeleton(): ReactElement {
  return (
    <div className="grid items-start gap-x-8 gap-y-3 @min-[720px]/overview:grid-cols-2">
      {[0, 1].map((col) => (
        <div key={col} className="flex flex-col gap-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ))}
    </div>
  );
}

/**
 * Now & next (agent-overview-2026 §5.4): what needs you, what is running (the mission-control
 * rows, each opening its Timeline at `/overview/run/<id>`) and the next three scheduled runs.
 */
export function NowSection({ now: fixedNow }: { now?: number }): ReactElement {
  const now = useNow(30_000, fixedNow);
  const persona = usePersona();
  const navigate = useSlots().navigate;
  const approvals = useApprovalQueue();
  const questions = useQuestions();
  const live = useRunsList({ status: ["running"] });
  useThreads();
  const threads = useStoreState((s) => s.threads);
  const upcoming = useUpcomingEntries();
  const { entries } = upcoming;
  const status = useSectionStatus("now", [
    { ...approvals, key: "approvals" },
    { ...questions, key: "questions" },
    { ...live, key: "running" },
    { ...upcoming, key: "upcoming" },
  ]);

  const running = live.runs.filter((r) => r.parentRunId == null);
  const needs = approvals.live.length + questions.open.length;
  const next = entries.flatMap((e) => (e.automation ? [e.automation] : [])).slice(0, NEXT_UP);
  const openRun = (runId: string) => navigate?.(overviewRunHref(runId));
  const firstNext = next[0];

  return (
    <OverviewSection id="now">
      <SectionBody id="now" status={status} reserve="min-h-28" skeleton={<NowSkeleton />}>
        {/* Two columns on a wide page: now (needs you, running) beside next up. */}
        <div
          className="grid items-start gap-x-8 gap-y-3 @min-[720px]/overview:grid-cols-2"
          data-testid="overview-now-body"
        >
          <section aria-label={t("overview.now.now")} className="flex min-w-0 flex-col gap-0.5">
            <Heading>{t("overview.now.now")}</Heading>
            {needs > 0 ? (
              <Row
                glyph="waiting"
                glyphLabel={t("agent.activity.waitingApproval")}
                title={t("overview.now.needsYou", { n: needs })}
                detail={t("overview.now.review")}
                {...(navigate
                  ? {
                      onOpen: () => navigate("/agent/approvals"),
                      openLabel: t("overview.now.needsYou", { n: needs }),
                    }
                  : {})}
              />
            ) : null}
            {running.length > 0 ? (
              <section aria-label={t("overview.now.running")}>
                <ul className="flex flex-col">
                  {running.map((r) => (
                    <li key={r.id}>
                      <NowRunRow
                        run={r}
                        title={runTitle(r, threads[r.threadId]?.thread.title)}
                        now={now}
                        onOpenRun={openRun}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {needs === 0 && running.length === 0 ? (
              <p className="px-2 py-1.5 text-body text-label-secondary">
                {firstNext?.nextRunAt
                  ? t("agent.activity.emptyNext", {
                      name: persona.name,
                      title: firstNext.title,
                      when: formatRelative(firstNext.nextRunAt, now),
                    })
                  : t("agent.activity.empty")}
              </p>
            ) : null}
          </section>
          {next.length > 0 ? (
            <section aria-label={t("agent.activity.nextUp")} className="flex flex-col gap-0.5">
              <Heading>{t("agent.activity.nextUp")}</Heading>
              <ul className="flex flex-col">
                {next.map((a) => (
                  <li key={a.id}>
                    <NextRow automation={a} now={now} onOpenRun={openRun} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </SectionBody>
    </OverviewSection>
  );
}
