import type { Automation, RunStatus, RunSummary, Task, TaskStatus } from "@psyche/protocol";
import { Search } from "lucide-react";
import { type ReactElement, type ReactNode, useMemo, useState } from "react";
import { TASK_STATUS_LABEL } from "../blocks/TaskCard.tsx";
import { DelayedSkeletons } from "../components/DelayedSkeleton.tsx";
import { Sparkline } from "../components/sparkline.tsx";
import {
  StatusGlyph,
  type StatusKind,
  type StepStatusKind,
  stepStatusKind,
} from "../components/status.tsx";
import { formatStepDuration, LiveDuration } from "../components/steps/LiveDuration.tsx";
import { Input } from "../components/ui/input.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.tsx";
import { useApprovals, useAutomations, useQuestions, useThreads } from "../data/index.ts";
import { useStoreState } from "../data/provider.tsx";
import { useRunsList } from "../data/runs.ts";
import { t } from "../i18n/core.ts";
import { formatRelative, formatTime } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { ListItem, Presence } from "../motion/primitives.tsx";
import { usePersona, useSlots } from "../slots.tsx";
import { runGlyph, runTitle } from "./timeline/RunHeader.tsx";

/**
 * Activity as mission control (docs/design/run-trace-2026.md §3.6): Needs you, Now, Next up and
 * Recent, for every kind of run (chat tasks, Tasks, automations; helpers fold under their parent).
 * Now rows carry the current step, live elapsed time and a 60 s activity sparkline; Next up shows
 * honest usual durations (only after 3 past runs); every row opens its Timeline.
 */

/** One glyph per task state across the app (redesign §3.6, `components/status.tsx`). */
export const TASK_GLYPH: Record<TaskStatus, StatusKind> = {
  queued: "pending",
  running: "running",
  awaiting_input: "waiting",
  awaiting_approval: "waiting",
  paused: "paused",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

const WEEK_MS = 7 * 24 * 3_600_000;
type RecentFilter = "all" | "failed" | "automations" | "chat";

/** The middle of the last runs' durations, once there are at least 3 (principle 7). */
export function usualDuration(durationsMs: readonly number[] | undefined): number | null {
  if (!durationsMs || durationsMs.length < 3) return null;
  const sorted = [...durationsMs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

export function Row({
  glyph,
  glyphLabel,
  title,
  tag,
  detail,
  trailing,
  onOpen,
  openLabel,
}: {
  glyph: StepStatusKind;
  glyphLabel: string;
  title: string;
  tag?: string;
  detail: ReactNode;
  trailing?: ReactNode;
  onOpen?: () => void;
  openLabel?: string;
}): ReactElement {
  const body = (
    <>
      <StatusGlyph status={glyph} label={glyphLabel} className="mt-0.5 size-4 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-headline">{title}</span>
          {tag ? <span className="shrink-0 text-callout text-label-tertiary">· {tag}</span> : null}
        </span>
        <span className="min-w-0 truncate text-callout text-label-secondary">{detail}</span>
      </span>
      {trailing ? (
        <span className="flex shrink-0 items-center gap-2 text-callout text-label-secondary tabular-nums">
          {trailing}
        </span>
      ) : null}
    </>
  );
  const cls =
    "flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
  return onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      aria-label={openLabel}
      className={cn(cls, "hover:bg-fill-quaternary")}
    >
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Section({
  title,
  children,
  id,
}: {
  title: string;
  children: ReactNode;
  id: string;
}): ReactElement {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-0.5">
      <h3 id={id} className="px-2 text-caption text-label-secondary">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** List enter and exit (motion.md §4.1); reduced motion fades (handled by the shared variants). */
function Items({ children }: { children: ReactNode[] }): ReactElement {
  return (
    <ul className="flex flex-col">
      <Presence initial={false}>{children}</Presence>
    </ul>
  );
}

function Item({ children }: { id: string; children: ReactNode }): ReactElement {
  return <ListItem>{children}</ListItem>;
}

export function recentDetail(run: RunSummary, now: number): string {
  const start = Date.parse(run.startedAt);
  const end = run.endedAt ? Date.parse(run.endedAt) : now;
  const duration = formatStepDuration(end - start);
  if (run.status === "failed") return t("agent.activity.stoppedAt", { n: run.stepCount ?? 1 });
  if (run.status === "cancelled") return t("agent.activity.stoppedByYou", { duration });
  return t("agent.activity.done", {
    duration,
    steps: t("agent.timeline.steps", { n: run.stepCount ?? 0 }),
  });
}

export function stateLabel(status: RunStatus): string {
  return t(
    `agent.timeline.state.${status === "awaiting_approval" || status === "awaiting_input" ? "waiting" : status}` as Parameters<
      typeof t
    >[0],
  );
}

/** Now: one running run with its current step, live elapsed time and activity sparkline. */
export function NowRunRow({
  run: r,
  title,
  now,
  onOpenRun,
}: {
  run: RunSummary;
  title: string;
  now: number;
  onOpenRun: (runId: string) => void;
}): ReactElement {
  return (
    <Row
      glyph={r.currentStep ? stepStatusKind(r.currentStep.status) : runGlyph(r.status)}
      glyphLabel={stateLabel(r.status)}
      title={title}
      {...(r.kind === "automation" ? { tag: t("agent.activity.automation") } : {})}
      detail={r.currentStep?.label ?? stateLabel(r.status)}
      trailing={
        <>
          <LiveDuration startedAt={Date.parse(r.startedAt)} now={now} />
          {r.activity ? (
            <Sparkline
              values={r.activity}
              live
              label={t("agent.activity.sparkSteps")}
              testId="activity-sparkline"
            />
          ) : null}
        </>
      }
      onOpen={() => onOpenRun(r.id)}
      openLabel={t("agent.activity.openTimeline", { title })}
    />
  );
}

/** Recent: one finished run, its outcome and when it started. */
export function RecentRunRow({
  run: r,
  title,
  now,
  onOpenRun,
}: {
  run: RunSummary;
  title: string;
  now: number;
  onOpenRun: (runId: string) => void;
}): ReactElement {
  return (
    <Row
      glyph={runGlyph(r.status)}
      glyphLabel={stateLabel(r.status)}
      title={title}
      {...(r.kind === "automation" ? { tag: t("agent.activity.automation") } : {})}
      detail={recentDetail(r, now)}
      trailing={
        <time dateTime={r.startedAt}>
          {now - Date.parse(r.startedAt) < 86_400_000
            ? formatTime(r.startedAt)
            : formatRelative(r.startedAt, now)}
        </time>
      }
      onOpen={() => onOpenRun(r.id)}
      openLabel={t("agent.activity.openTimeline", { title })}
    />
  );
}

/** Next up: one automation with its countdown, usual duration and last runs. */
export function NextRow({
  automation,
  now,
  onOpenRun,
}: {
  automation: Automation;
  now: number;
  onOpenRun: (runId: string) => void;
}): ReactElement {
  const last = useRunsList({ automationId: automation.id, limit: 1 });
  const latest = last.runs[0];
  const durations = latest?.durationsMs;
  const usual = usualDuration(durations);
  const when = automation.nextRunAt ? formatRelative(automation.nextRunAt, now) : "";
  return (
    <Row
      glyph="pending"
      glyphLabel={t("agent.activity.queued")}
      title={automation.title}
      tag={t("agent.activity.automation")}
      detail={
        usual === null
          ? when
          : `${when} · ${t("agent.activity.usually", { duration: formatStepDuration(usual) })}`
      }
      trailing={
        durations && durations.length > 1 ? (
          <Sparkline
            values={[...durations].reverse()}
            label={t("agent.activity.sparkDurations", { n: durations.length })}
            testId="durations-sparkline"
          />
        ) : undefined
      }
      {...(latest
        ? {
            onOpen: () => onOpenRun(latest.id),
            openLabel: t("agent.activity.openTimeline", { title: automation.title }),
          }
        : {})}
    />
  );
}

export interface MissionControlProps {
  onOpenRun: (runId: string) => void;
  /** Tasks the run list doesn't cover yet (queued, or from before the run trace). */
  tasks: readonly Task[];
  onOpenTask: (taskId: string) => void;
  now: number;
}

function TaskRow({
  task,
  now,
  onOpen,
}: {
  task: Task;
  now: number;
  onOpen: (taskId: string) => void;
}): ReactElement {
  return (
    <Row
      glyph={TASK_GLYPH[task.status]}
      glyphLabel={TASK_STATUS_LABEL[task.status]}
      title={task.title}
      detail={task.summary ?? TASK_STATUS_LABEL[task.status]}
      trailing={formatRelative(task.updatedAt, now)}
      onOpen={() => onOpen(task.id)}
      openLabel={t("agent.activity.openTimeline", { title: task.title })}
    />
  );
}

export function MissionControl({
  onOpenRun,
  tasks,
  onOpenTask,
  now,
}: MissionControlProps): ReactElement {
  const persona = usePersona();
  const slots = useSlots();
  const approvals = useApprovals();
  const questions = useQuestions();
  const automations = useAutomations();
  // Runs waiting on you show under Needs you through their card; Now is what's working.
  const live = useRunsList({ status: ["running"] });
  // Chat tasks without a title read as their thread; the list loads the threads' titles.
  useThreads();
  const threads = useStoreState((s) => s.threads);
  const title = (r: RunSummary) => runTitle(r, threads[r.threadId]?.thread.title);
  const since = useMemo(() => new Date(now - WEEK_MS).toISOString(), [now]);
  const recentList = useRunsList({ status: ["done", "failed", "cancelled"], since });
  const [filter, setFilter] = useState<RecentFilter>("all");
  const [query, setQuery] = useState("");

  const nowRuns = live.runs.filter((r) => r.parentRunId == null);
  const nextUp = [...automations.automations]
    .filter((a) => a.enabled && a.nextRunAt !== null)
    .sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""));
  const recent = recentList.runs
    .filter((r) => r.parentRunId == null)
    .filter((r) =>
      filter === "failed"
        ? r.status === "failed"
        : filter === "automations"
          ? r.kind === "automation"
          : filter === "chat"
            ? r.kind === "chat"
            : true,
    )
    .filter((r) => title(r).toLowerCase().includes(query.trim().toLowerCase()));
  // Tasks the runs don't already show (a run carries its taskId; cards carry theirs).
  const runTasks = new Set(
    [...live.runs, ...recentList.runs].flatMap((r) => (r.taskId ? [r.taskId] : [])),
  );
  const cardTasks = new Set([
    ...approvals.pending.flatMap((v) =>
      v.approval.requestedBy.taskId ? [v.approval.requestedBy.taskId] : [],
    ),
    ...questions.open.flatMap((q) => (q.taskId ? [q.taskId] : [])),
  ]);
  const taskOnly = tasks.filter((x) => !runTasks.has(x.id));
  const tasksNeeding = taskOnly.filter(
    (x) => x.status.startsWith("awaiting") && !cardTasks.has(x.id),
  );
  const tasksNow = taskOnly.filter((x) => x.status === "running" || x.status === "paused");
  const tasksNext = taskOnly.filter((x) => x.status === "queued");
  const tasksRecent = taskOnly
    .filter(
      (x) =>
        (x.status === "done" || x.status === "failed" || x.status === "cancelled") &&
        now - Date.parse(x.updatedAt) < WEEK_MS,
    )
    .filter((x) => (filter === "failed" ? x.status === "failed" : filter === "all"))
    .filter((x) => x.title.toLowerCase().includes(query.trim().toLowerCase()));
  const needs = approvals.pending.length + questions.open.length + tasksNeeding.length;
  const nextAutomation = nextUp[0];

  return (
    <div className="flex flex-col gap-4" data-testid="mission-control">
      {needs === 0 && nowRuns.length === 0 && tasksNow.length === 0 ? (
        <p className="px-2 text-body text-label-secondary">
          {nextAutomation?.nextRunAt
            ? t("agent.activity.emptyNext", {
                name: persona.name,
                title: nextAutomation.title,
                when: formatRelative(nextAutomation.nextRunAt, now),
              })
            : t("agent.activity.empty")}
        </p>
      ) : null}
      {needs > 0 ? (
        <Section id="activity-needs-you" title={t("agent.activity.needsYou", { n: needs })}>
          <Items>
            {[
              ...approvals.pending.map((v) => (
                <Item key={v.approval.id} id={v.approval.id}>
                  <Row
                    glyph="waiting"
                    glyphLabel={t("agent.activity.waitingApproval")}
                    title={v.approval.summary}
                    detail={t("agent.activity.waitingApproval")}
                    trailing={formatRelative(v.approval.requestedAt, now)}
                    {...(slots.navigate
                      ? {
                          onOpen: () => slots.navigate?.("/agent/approvals"),
                          openLabel: v.approval.summary,
                        }
                      : {})}
                  />
                </Item>
              )),
              ...questions.open.map((q) => (
                <Item key={q.id} id={q.id}>
                  <Row
                    glyph="waiting"
                    glyphLabel={t("agent.activity.waitingAnswer")}
                    title={q.questions[0]?.question ?? t("agent.activity.waitingAnswer")}
                    detail={t("agent.activity.waitingAnswer")}
                    trailing={formatRelative(q.createdAt, now)}
                    {...(slots.navigate
                      ? {
                          onOpen: () => slots.navigate?.(`/chat/${q.threadId}`),
                          openLabel: q.questions[0]?.question ?? t("agent.activity.waitingAnswer"),
                        }
                      : {})}
                  />
                </Item>
              )),
              ...tasksNeeding.map((x) => (
                <Item key={x.id} id={x.id}>
                  <TaskRow task={x} now={now} onOpen={onOpenTask} />
                </Item>
              )),
            ]}
          </Items>
        </Section>
      ) : null}
      {nowRuns.length + tasksNow.length > 0 ? (
        <Section
          id="activity-now"
          title={t("agent.activity.now", { n: nowRuns.length + tasksNow.length })}
        >
          <Items>
            {nowRuns.map((r) => (
              <Item key={r.id} id={r.id}>
                <NowRunRow run={r} title={title(r)} now={now} onOpenRun={onOpenRun} />
              </Item>
            ))}
            {tasksNow.map((x) => (
              <Item key={x.id} id={x.id}>
                <TaskRow task={x} now={now} onOpen={onOpenTask} />
              </Item>
            ))}
          </Items>
        </Section>
      ) : null}
      {nextUp.length + tasksNext.length > 0 ? (
        <Section id="activity-next-up" title={t("agent.activity.nextUp")}>
          <Items>
            {tasksNext.map((x) => (
              <Item key={x.id} id={x.id}>
                <TaskRow task={x} now={now} onOpen={onOpenTask} />
              </Item>
            ))}
            {nextUp.map((a) => (
              <Item key={a.id} id={a.id}>
                <NextRow automation={a} now={now} onOpenRun={onOpenRun} />
              </Item>
            ))}
          </Items>
        </Section>
      ) : null}
      <Section id="activity-recent" title={t("agent.activity.recent")}>
        <div className="flex flex-wrap items-center gap-2 px-2 pb-1">
          <ToggleGroup
            aria-label={t("agent.activity.recentFilter")}
            value={[filter]}
            onValueChange={(v) => {
              const next = v[0];
              if (next !== undefined) setFilter(next as RecentFilter);
            }}
          >
            {(
              [
                ["all", "agent.activity.filterAll"],
                ["failed", "agent.activity.filterFailed"],
                ["automations", "agent.activity.filterAutomations"],
                ["chat", "agent.activity.filterChat"],
              ] as const
            ).map(([value, key]) => (
              <ToggleGroupItem key={value} value={value} size="sm">
                {t(key)}
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
        {recentList.loading && recentList.runs.length === 0 ? (
          <DelayedSkeletons
            className="flex flex-col gap-1 px-2"
            label={t("agent.activity.loading")}
          >
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </DelayedSkeletons>
        ) : recent.length + tasksRecent.length === 0 ? (
          <p className="px-2 py-2 text-body text-label-secondary">
            {query || filter !== "all"
              ? t("agent.activity.noMatches")
              : t("agent.activity.noRecent")}
          </p>
        ) : (
          <Items>
            {[
              ...tasksRecent.map((x) => ({
                at: x.updatedAt,
                node: (
                  <Item key={x.id} id={x.id}>
                    <TaskRow task={x} now={now} onOpen={onOpenTask} />
                  </Item>
                ),
              })),
              ...recent.map((r) => ({
                at: r.startedAt,
                node: (
                  <Item key={r.id} id={r.id}>
                    <RecentRunRow run={r} title={title(r)} now={now} onOpenRun={onOpenRun} />
                  </Item>
                ),
              })),
            ]
              // Newest first, Tasks and runs together.
              .sort((x, y) => y.at.localeCompare(x.at))
              .map((e) => e.node)}
          </Items>
        )}
      </Section>
    </div>
  );
}
