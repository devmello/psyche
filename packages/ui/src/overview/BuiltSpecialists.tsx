import type { Artifact, SpecialistJob } from "@psyche/protocol";
import { type ReactElement, useMemo } from "react";
import { ArtifactTile } from "../blocks/ArtifactCard.tsx";
import { ChartView } from "../canvas/ChartView.tsx";
import { useArtifactContent, useInsights, useRecentArtifacts } from "../data/index.ts";
import { useSpecialistJobs, useSpecialistRoles } from "../data/specialists.ts";
import { t } from "../i18n/core.ts";
import { useSlots } from "../slots.tsx";
import { SpecialistRow, useSpecialistActions } from "../specialists/InboxRow.tsx";
import { OverviewSection } from "./OverviewSection.tsx";
import { type OverviewPeriod, periodDays } from "./period.ts";

/**
 * "Built for you" and "Specialists" (docs/design/agent-overview-2026.md §5.4). Each is its own
 * section card; the period and the clock come from the screen.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Artifacts in the grid (§5.4). */
export const BUILT_LIMIT = 8;
/** Specialist results listed (§5.4). */
export const SPECIALIST_LIMIT = 3;
const RESULT_STATUSES: SpecialistJob["status"][] = ["done", "partial", "failed"];
/** Library → Artifacts, which `/library/:section` routes. */
export const ARTIFACTS_LIBRARY_ROUTE = "/library/artifacts";

/** True when `iso` is inside the period ending at `now` (all time takes everything). */
export function inPeriod(iso: string, period: OverviewPeriod, now: number): boolean {
  const days = periodDays(period);
  if (days === null) return true;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? false : at >= now - days * DAY_MS;
}

export interface OverviewPeriodProps {
  period: OverviewPeriod;
  /** Epoch ms the period ends at. */
  now: number;
  /**
   * Opens an artifact in its thread's canvas pane. Defaults to the host's `slots.openArtifact`
   * (the shell dispatches `openArtifactAction`), then to the artifact's thread.
   */
  onOpenArtifact?: (artifact: Artifact) => void;
}

/** A chart artifact's real `ChartView`, read from its latest version; the drawn page until then. */
function ChartThumb({ artifact }: { artifact: Artifact }): ReactElement | null {
  const { content } = useArtifactContent(artifact.id, null);
  const chart = useMemo(() => {
    if (content === null) return null;
    try {
      const parsed = JSON.parse(content.content) as {
        series?: unknown;
        categories?: unknown;
      };
      return Array.isArray(parsed.series) && Array.isArray(parsed.categories) ? parsed : null;
    } catch {
      return null;
    }
  }, [content]);
  if (chart === null) return null;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden bg-background p-1">
      {/* The plot only: the title is the tile's, and the legend and data table are in the canvas. */}
      <div className="size-full [&_figcaption]:hidden [&_figure]:h-full [&_figure]:max-w-none [&_figure>div]:min-h-0 [&_figure>div]:flex-1 [&_figure>ul]:hidden [&_svg]:size-full">
        <ChartView chart={chart as Parameters<typeof ChartView>[0]["chart"]} />
      </div>
    </div>
  );
}

function BuiltTile({
  artifact,
  onOpen,
}: {
  artifact: Artifact;
  onOpen: (a: Artifact) => void;
}): ReactElement {
  const { renderPreview } = useSlots();
  return (
    <ArtifactTile
      artifact={artifact}
      label={t("overview.built.open", { title: artifact.title })}
      onOpen={onOpen}
      {...(renderPreview ? { renderPreview } : {})}
      {...(artifact.type === "chart" ? { thumbnail: <ChartThumb artifact={artifact} /> } : {})}
    />
  );
}

/** Artifacts Psyche made in the period, newest first, charts as real thumbnails. */
export function BuiltForYou({ period, now, onOpenArtifact }: OverviewPeriodProps): ReactElement {
  const { navigate, openArtifact } = useSlots();
  const { data } = useInsights(period);
  const { artifacts } = useRecentArtifacts(BUILT_LIMIT);
  const shown = useMemo(
    () => artifacts.filter((a) => inPeriod(a.updatedAt, period, now)).slice(0, BUILT_LIMIT),
    [artifacts, period, now],
  );
  const open = (artifact: Artifact): void => {
    if (onOpenArtifact) onOpenArtifact(artifact);
    else if (openArtifact) openArtifact(artifact);
    else if (artifact.threadId) navigate?.(`/chat/${artifact.threadId}`);
  };
  return (
    <OverviewSection
      id="built"
      {...(data
        ? { meta: t("overview.built.meta", { count: data.totals.artifacts.created }) }
        : {})}
      actions={[
        {
          id: "see-all",
          label: t("overview.built.seeAll"),
          kind: "open",
          onSelect: () => navigate?.(ARTIFACTS_LIBRARY_ROUTE),
        },
      ]}
    >
      {shown.length === 0 ? (
        <p className="text-callout text-label-tertiary">{t("overview.built.empty")}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 @min-[480px]/overview:grid-cols-2 @min-[720px]/overview:grid-cols-4">
          {shown.map((a) => (
            <li key={a.id} className="min-w-0">
              <BuiltTile artifact={a} onOpen={open} />
            </li>
          ))}
        </ul>
      )}
    </OverviewSection>
  );
}

function JobRow({
  job,
  roles,
  now,
}: {
  job: SpecialistJob;
  roles: ReturnType<typeof useSpecialistRoles>["roles"];
  now: number;
}): ReactElement {
  const actions = useSpecialistActions(job);
  return <SpecialistRow job={job} roles={roles} now={now} {...actions} />;
}

/** The latest finished specialist results; hidden when no specialist role is enabled. */
export function Specialists({ period, now }: OverviewPeriodProps): ReactElement | null {
  const { roles } = useSpecialistRoles();
  const { data } = useInsights(period);
  const { jobs } = useSpecialistJobs({ status: RESULT_STATUSES });
  const shown = useMemo(
    () =>
      jobs
        .filter((j) => j.result != null && inPeriod(j.updatedAt, period, now))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, SPECIALIST_LIMIT),
    [jobs, period, now],
  );
  if (!roles.some((r) => r.enabled)) return null;
  const count = data
    ? data.totals.specialists.done +
      data.totals.specialists.partial +
      data.totals.specialists.failed
    : null;
  return (
    <OverviewSection
      id="specialists"
      {...(count === null ? {} : { meta: t("overview.specialists.meta", { count }) })}
    >
      {shown.length === 0 ? (
        <p className="text-callout text-label-tertiary">{t("overview.specialists.empty")}</p>
      ) : (
        <ul className="-mx-3 flex flex-col">
          {shown.map((job) => (
            <li key={job.taskId}>
              <JobRow job={job} roles={roles} now={now} />
            </li>
          ))}
        </ul>
      )}
    </OverviewSection>
  );
}
