import type { FeedPost, GrowthSummary } from "@psyche/protocol";
import { type ReactElement, type ReactNode, useState } from "react";
import type { CardAction } from "../blocks/card.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { useGatewayQuery } from "../data/index.ts";
import { activeI18n, t } from "../i18n/core.ts";
import { usePersona } from "../slots.tsx";
import { GrowthCardItems } from "../teaching/GrowthCard.tsx";
import { GrowthTimeline, MetricRow, MilestoneRow, weekOf } from "../teaching/GrowthPanel.tsx";
import { OverviewSection } from "./OverviewSection.tsx";
import type { OverviewPeriod } from "./period.ts";

/** Milestones listed in the section; the rest are in the lessons sheet's timeline. */
const MILESTONES_SHOWN = 3;

export const periodMeta = (period: OverviewPeriod): string => t(`overview.meta.${period}`);

export interface GrowthSectionProps {
  /** The page's period; it is also the `growth.summary` window. */
  period: OverviewPeriod;
  /** Epoch ms, to tell this week's card from an older one (stories pin it). */
  now?: number;
}

/**
 * Growth (docs/design/agent-overview-2026.md §5.4): `GrowthPanel`'s pieces against the page's
 * window. Lesson counts, the outcome metrics with their previous rate and evidence, milestones
 * as dated facts, the week-grouped timeline behind "See all lessons", and the weekly
 * "What I learned" card as a row that opens its review items in a sheet.
 */
export function GrowthSection({ period, now }: GrowthSectionProps): ReactElement {
  const persona = usePersona();
  const q = useGatewayQuery("growth.summary", { window: period });
  const feed = useGatewayQuery("feed.list", {});
  const [lessonsOpen, setLessonsOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const summary = q.data?.summary;
  const post = feed.data?.posts
    .filter((p) => p.growth !== undefined)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  const actions: CardAction[] =
    summary !== undefined && summary.timeline.length > 0
      ? [
          {
            id: "see-all-lessons",
            label: t("overview.growth.seeAll"),
            kind: "open",
            onSelect: () => setLessonsOpen(true),
          },
        ]
      : [];

  let body: ReactNode;
  if (summary === undefined) {
    body = q.error ? (
      <p className="text-callout text-label-secondary" role="alert">
        {t("overview.growth.loadFailed")} ·{" "}
        <button
          type="button"
          className="rounded-sm text-accent-11 underline outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={q.reload}
        >
          {t("common.retry")}
        </button>
      </p>
    ) : (
      <div className="flex flex-col gap-2" role="status" aria-label={t("overview.growth.loading")}>
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    );
  } else {
    body = (
      <GrowthBody
        summary={summary}
        agent={persona.name}
        post={post}
        now={now}
        onOpenLessons={() => setLessonsOpen(true)}
        onOpenCard={() => setCardOpen(true)}
      />
    );
  }

  return (
    <>
      <OverviewSection id="growth" meta={periodMeta(period)} actions={actions}>
        {body}
      </OverviewSection>
      {summary === undefined ? null : (
        <Sheet open={lessonsOpen} onOpenChange={setLessonsOpen}>
          <SheetContent className="overflow-y-auto p-4 sm:max-w-md" data-testid="growth-lessons">
            <SheetHeader className="p-0">
              <SheetTitle>{t("overview.growth.sheetTitle", { agent: persona.name })}</SheetTitle>
              <SheetDescription>{periodMeta(period)}</SheetDescription>
            </SheetHeader>
            <GrowthTimeline items={summary.timeline} agent={persona.name} />
          </SheetContent>
        </Sheet>
      )}
      {post?.growth === undefined ? null : (
        <Sheet open={cardOpen} onOpenChange={setCardOpen}>
          <SheetContent className="overflow-y-auto p-4 sm:max-w-md" data-testid="growth-card-sheet">
            <SheetHeader className="p-0">
              <SheetTitle>
                {t("overview.growth.card.sheetTitle", { agent: persona.name })}
              </SheetTitle>
              <SheetDescription>
                {t("overview.growth.card.sheetDescription", { agent: persona.name })}
              </SheetDescription>
            </SheetHeader>
            <GrowthCardItems postId={post.id} card={post.growth} />
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}

function GrowthBody({
  summary,
  agent,
  post,
  now,
  onOpenLessons,
  onOpenCard,
}: {
  summary: GrowthSummary;
  agent: string;
  post: FeedPost | undefined;
  now: number | undefined;
  onOpenLessons: () => void;
  onOpenCard: () => void;
}): ReactElement {
  const counts = [
    ["learned", summary.lessons.learned],
    ["refined", summary.lessons.refined],
    ["confirmed", summary.lessons.confirmed],
    ["forgotten", summary.lessons.forgotten],
  ] as const;
  const empty = summary.timeline.length === 0;
  const milestones = [...summary.milestones]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, MILESTONES_SHOWN);
  return (
    <div className="flex flex-col gap-4" data-testid="overview-growth">
      {empty ? (
        <p className="text-callout text-label-tertiary">{t("overview.growth.empty")}</p>
      ) : (
        <ul
          aria-label={t("overview.growth.counts")}
          className="flex flex-wrap gap-x-3 gap-y-1 text-callout text-label-secondary"
        >
          {counts.map(([kind, n]) => (
            <li key={kind}>
              <button
                type="button"
                data-testid={`growth-count-${kind}`}
                onClick={onOpenLessons}
                className="rounded-sm tabular-nums outline-none hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t(`overview.growth.${kind}`, { n })}
              </button>
            </li>
          ))}
        </ul>
      )}

      {summary.metrics.length > 0 ? (
        <section aria-label={t("screens.growth.better")}>
          <h4 className="text-caption text-label-secondary">{t("screens.growth.better")}</h4>
          <ul className="divide-y divide-separator">
            {summary.metrics.map((m) => (
              <MetricRow key={`${m.id}:${m.skill ?? ""}`} metric={m} evidencePopover />
            ))}
          </ul>
        </section>
      ) : null}

      {post?.growth === undefined ? null : (
        <WeeklyCardRow post={post} now={now} onOpen={onOpenCard} />
      )}

      {milestones.length > 0 ? (
        <section aria-label={t("overview.growth.milestones")}>
          <h4 className="text-caption text-label-secondary">{t("overview.growth.milestones")}</h4>
          <ul className="divide-y divide-separator">
            {milestones.map((m) => (
              <MilestoneRow key={`${m.kind}:${m.at}`} milestone={m} agent={agent} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** "This week's lessons (3) · Review": the weekly card, opened in a sheet. */
function WeeklyCardRow({
  post,
  now,
  onOpen,
}: {
  post: FeedPost;
  now: number | undefined;
  onOpen: () => void;
}): ReactElement | null {
  const card = post.growth;
  if (card === undefined) return null;
  const n = card.items.length;
  const current = now !== undefined && weekOf(new Date(now).toISOString()) === card.weekOf;
  const label = current
    ? t("overview.growth.card.thisWeek", { n })
    : t("overview.growth.card.week", {
        n,
        date: activeI18n().date(`${card.weekOf}T12:00:00Z`, {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }),
      });
  return (
    <div className="flex items-center justify-between gap-3 py-1" data-testid="growth-weekly-card">
      <span className="text-body text-label-primary">{label}</span>
      <Button size="sm" variant="secondary" onClick={onOpen}>
        {t("overview.growth.card.review")}
      </Button>
    </div>
  );
}
