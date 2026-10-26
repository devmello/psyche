import type { GrowthItem, GrowthMetric, GrowthWindow, Lesson, Milestone } from "@psyche/protocol";
import { Diamond, Ellipsis, Sprout } from "lucide-react";
import { type ReactElement, useState } from "react";
import { EmptyState } from "../components/page.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "../components/ui/popover.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.tsx";
import { useGatewayQuery } from "../data/index.ts";
import { activeI18n, t } from "../i18n/core.ts";
import { formatDate } from "../lib/format.ts";
import { usePersona } from "../slots.tsx";
import { useTeaching } from "./hooks.ts";
import { ChangeLines } from "./LessonMark.tsx";

/**
 * Agent sheet → Growth (teaching loop §5.3): how the agent has grown for the owner. A timeline of
 * lessons and milestones, newest first and grouped by week, and "What got better": outcome
 * metrics against the agent's own previous period, counts always beside rates.
 */

const WINDOWS: readonly GrowthWindow[] = ["7d", "30d", "all"];
type Filter = "all" | "stated" | "inferred";

/** "You told me" · "From your feedback" · "Noticed 3 times" · "You confirmed". */
export function provenanceOf(lesson: Lesson): string {
  if (lesson.status === "confirmed") return t("screens.growth.provenance.confirmed");
  if (lesson.origin === "stated") return t("screens.growth.provenance.stated");
  return lesson.sources.length > 1
    ? t("screens.growth.provenance.noticed", { n: lesson.sources.length })
    : t("screens.growth.provenance.feedback");
}

/** Where the lesson lives, in words: "SOUL.md", "inbox-triage skill", "Upcoming". */
export function destinationOf(lesson: Lesson): string {
  const d = lesson.destination;
  switch (d.type) {
    case "file":
      return d.path;
    case "skill":
      return t("screens.growth.destination.skill", { skill: d.skill });
    case "automation":
      return t("screens.growth.destination.automation");
    case "graph":
      return t("screens.growth.destination.graph");
  }
}

export function milestoneText(m: Milestone, agent: string): string {
  return t(`screens.growth.milestone.${m.kind}`, { agent, subject: m.subject ?? "" });
}

/** Monday of the item's week, as the group key (`YYYY-MM-DD`, UTC). */
export function weekOf(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export function LessonRow({ lesson }: { lesson: Lesson }): ReactElement {
  const teach = useTeaching();
  const [open, setOpen] = useState(false);
  return (
    <li className="flex gap-3 py-2" data-testid="growth-lesson">
      <time
        dateTime={lesson.createdAt}
        className="w-14 shrink-0 text-callout text-label-secondary tabular-nums"
      >
        {formatDate(lesson.createdAt)}
      </time>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-body text-label-primary">{lesson.statement}</span>
        <span className="flex flex-wrap items-center gap-x-1.5 text-caption text-label-secondary">
          <span>{provenanceOf(lesson)}</span>
          <span aria-hidden="true">·</span>
          <span className={lesson.destination.type === "file" ? "font-mono" : undefined}>
            {destinationOf(lesson)}
          </span>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="rounded-sm text-label-primary underline decoration-dotted underline-offset-2 outline-none hover:decoration-solid focus-visible:ring-3 focus-visible:ring-ring"
          >
            {open ? t("screens.growth.hideChange") : t("screens.growth.showChange")}
          </button>
        </span>
        {open ? <ChangeLines before={lesson.previous} after={lesson.value} /> : null}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("screens.growth.more", { statement: lesson.statement })}
            />
          }
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onClick={() => void teach.forget(lesson.id)}>
            {t("screens.lessons.forget")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

export function MilestoneRow({
  milestone,
  agent,
}: {
  milestone: Milestone;
  agent: string;
}): ReactElement {
  return (
    <li className="flex gap-3 py-2" data-testid="growth-milestone">
      <time
        dateTime={milestone.at}
        className="w-14 shrink-0 text-callout text-label-secondary tabular-nums"
      >
        {formatDate(milestone.at)}
      </time>
      <span className="flex items-center gap-1.5 text-body text-label-primary">
        <Diamond className="size-3 fill-current text-label-secondary" aria-hidden="true" />
        {milestoneText(milestone, agent)}
      </span>
    </li>
  );
}

/**
 * One outcome metric: its label, rate or count, and the previous period beside it. With
 * `evidencePopover`, "Based on n events" opens the evidence ids behind the number.
 */
export function MetricRow({
  metric,
  evidencePopover = false,
}: {
  metric: GrowthMetric;
  evidencePopover?: boolean;
}): ReactElement {
  const name = t(`screens.growth.metric.${metric.id}`);
  const label = metric.skill
    ? t("screens.growth.metricSkill", { skill: metric.skill, metric: name })
    : name;
  const value =
    metric.total === 0
      ? t("screens.growth.thin")
      : metric.rate === null || metric.rate === undefined
        ? t("screens.growth.metricCount", { count: metric.count, total: metric.total })
        : t("screens.growth.metricRate", {
            rate: metric.rate,
            count: metric.count,
            total: metric.total,
          });
  const was =
    metric.previousRate !== null && metric.previousRate !== undefined
      ? t("screens.growth.wasRate", { rate: metric.previousRate })
      : metric.previousTotal
        ? t("screens.growth.wasCount", {
            count: metric.previousCount ?? 0,
            total: metric.previousTotal,
          })
        : null;
  return (
    <li className="flex flex-col gap-0.5 py-2" data-testid="growth-metric">
      <span className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-body text-label-primary">{label}</span>
        <span className="text-callout text-label-primary tabular-nums">
          <bdi>{value}</bdi>
          {was ? (
            <span className="text-label-secondary">
              {" ("}
              <bdi>{was}</bdi>
              {")"}
            </span>
          ) : null}
        </span>
      </span>
      {metric.evidence.length === 0 ? null : evidencePopover ? (
        <EvidencePopover label={label} evidence={metric.evidence} />
      ) : (
        <span className="text-caption text-label-secondary">
          {t("screens.growth.evidence", { n: metric.evidence.length })}
        </span>
      )}
    </li>
  );
}

/** "Based on 12 events", opening the ids of the events behind a metric. */
function EvidencePopover({
  label,
  evidence,
}: {
  label: string;
  evidence: readonly string[];
}): ReactElement {
  return (
    <Popover>
      <PopoverTrigger
        className="self-start rounded-sm text-caption text-label-secondary underline decoration-dotted underline-offset-2 outline-none hover:decoration-solid focus-visible:ring-3 focus-visible:ring-ring"
        data-testid="growth-evidence"
      >
        {t("screens.growth.evidence", { n: evidence.length })}
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-64 w-72 overflow-auto">
        <PopoverTitle>{t("overview.growth.evidenceTitle", { metric: label })}</PopoverTitle>
        <ul className="flex flex-col gap-1 text-caption text-label-secondary">
          {evidence.map((id) => (
            <li key={id} className="font-mono break-all">
              {id}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** Timeline items grouped by the week they fall in, newest first: the lists under each heading. */
export function GrowthTimeline({
  items,
  agent,
}: {
  items: readonly GrowthItem[];
  agent: string;
}): ReactElement {
  const weeks = new Map<string, GrowthItem[]>();
  for (const item of items) {
    const key = weekOf(item.at);
    weeks.set(key, [...(weeks.get(key) ?? []), item]);
  }
  return (
    <>
      {[...weeks.entries()].map(([week, list]) => (
        <section key={week} aria-label={t("screens.growth.week", { date: weekLabel(week) })}>
          <h4 className="mt-2 text-caption text-label-secondary">
            {t("screens.growth.week", { date: weekLabel(week) })}
          </h4>
          <ul className="divide-y divide-separator">
            {list.map((item) =>
              item.type === "lesson" ? (
                <LessonRow key={item.lesson.id} lesson={item.lesson} />
              ) : (
                <MilestoneRow
                  key={`${item.milestone.kind}:${item.at}`}
                  milestone={item.milestone}
                  agent={agent}
                />
              ),
            )}
          </ul>
        </section>
      ))}
    </>
  );
}

export function GrowthPanel({ defaultWindow = "30d" }: { defaultWindow?: GrowthWindow }) {
  const persona = usePersona();
  const [window, setWindow] = useState<GrowthWindow>(defaultWindow);
  const [filter, setFilter] = useState<Filter>("all");
  const q = useGatewayQuery("growth.summary", { window });
  const summary = q.data?.summary;

  const header = (
    <ToggleGroup
      aria-label={t("screens.growth.window")}
      value={[window]}
      onValueChange={(v) => {
        const next = v[0] as GrowthWindow | undefined;
        if (next) setWindow(next);
      }}
      className="self-end"
    >
      {WINDOWS.map((w) => (
        <ToggleGroupItem key={w} value={w} size="sm">
          {t(`screens.growth.window.${w}`)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );

  if (summary === undefined) {
    return (
      <div className="flex flex-col gap-4 px-2">
        {header}
        {q.error ? (
          <p className="text-body" role="alert">
            {t("screens.growth.loadFailed", { reason: q.error })}{" "}
            <button type="button" className="text-accent-11 underline" onClick={q.reload}>
              {t("screens.growth.retry")}
            </button>
          </p>
        ) : (
          <div
            className="flex flex-col gap-2"
            role="status"
            aria-label={t("screens.growth.loading", { agent: persona.name })}
          >
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        )}
      </div>
    );
  }

  const items = summary.timeline.filter(
    (i: GrowthItem) => i.type === "milestone" || filter === "all" || i.lesson.origin === filter,
  );
  if (summary.timeline.length === 0) {
    return (
      <div className="flex flex-col gap-4 px-2">
        {header}
        <EmptyState icon={Sprout}>{t("screens.growth.empty", { agent: persona.name })}</EmptyState>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5 px-2" data-testid="growth">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-callout text-label-secondary">
          {t("screens.growth.summaryLine", {
            period: t(`screens.growth.period.${window}`),
            learned: summary.lessons.learned,
            refined: summary.lessons.refined,
          })}
        </p>
        {header}
      </div>

      <section aria-label={t("screens.growth.timeline", { agent: persona.name })}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-headline text-label-primary">
            {t("screens.growth.timeline", { agent: persona.name })}
          </h3>
          <ToggleGroup
            aria-label={t("screens.growth.filter")}
            value={[filter]}
            onValueChange={(v) => {
              const next = v[0] as Filter | undefined;
              if (next) setFilter(next);
            }}
          >
            {(["all", "stated", "inferred"] as const).map((f) => (
              <ToggleGroupItem key={f} value={f} size="sm">
                {t(`screens.growth.filter.${f}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <GrowthTimeline items={items} agent={persona.name} />
      </section>

      {summary.metrics.length > 0 ? (
        <section aria-label={t("screens.growth.better")}>
          <h3 className="mb-1 text-headline text-label-primary">{t("screens.growth.better")}</h3>
          <ul className="divide-y divide-separator">
            {summary.metrics.map((m) => (
              <MetricRow key={`${m.id}:${m.skill ?? ""}`} metric={m} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** "2026-10-19" → "Oct 19" (UTC, the group key's own day). */
export function weekLabel(date: string): string {
  return activeI18n().date(`${date}T12:00:00Z`, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
