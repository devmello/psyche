import type { Task, TaskAction } from "@psyche/protocol";
import { ArrowLeft, ListChecks } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { DISCLOSURE_LABEL, type DisclosureLevel } from "../blocks/disclosure.tsx";
import { TASK_STATUS_LABEL } from "../blocks/TaskCard.tsx";
import { EmptyState } from "../components/page.tsx";
import { StatusGlyph } from "../components/status.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.tsx";
import { useSpecialistJob, useTask, useTasks } from "../data/index.ts";
import { useStoreState } from "../data/provider.tsx";
import { useRunsList } from "../data/runs.ts";
import { t } from "../i18n/core.ts";
import { formatRelative, formatTime } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { useSlots } from "../slots.tsx";
import { SpecialistControls } from "../specialists/Controls.tsx";
import { agentTimelineHref } from "./AgentSheet.tsx";
import { MissionControl, TASK_GLYPH } from "./MissionControl.tsx";

export { TASK_GLYPH };

import { DelayedSkeleton } from "../components/DelayedSkeleton.tsx";
import { AuditView } from "./AuditView.tsx";
import { TimelineView } from "./timeline/TimelineView.tsx";

/**
 * An action's outcome as a semantic chip (§4.8): "ok · 12s · r-101" reads as a success chip
 * "ok" followed by the muted rest; failures are danger, waiting and unknown outcomes approval.
 */
export function outcomeTone(outcome: string): "success" | "danger" | "approval" {
  const head = outcome.trim().toLowerCase();
  if (/^(ok|done|delivered|sent|saved)\b/.test(head)) return "success";
  if (/^(failed|error|denied|refused|cancelled)\b/.test(head)) return "danger";
  return "approval";
}

function Outcome({ outcome }: { outcome: string }): ReactElement {
  const [head = outcome, ...rest] = outcome.split(" · ");
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <Badge variant={outcomeTone(outcome)}>{head}</Badge>
      {rest.length > 0 ? (
        <span className="text-callout text-label-secondary">{rest.join(" · ")}</span>
      ) : null}
    </span>
  );
}

/** Task rows (UI design §3.14): status glyph, title, status text, origin, lease owner. */
export function TaskList({
  tasks,
  onSelect,
  onRetry,
  onResume,
  now,
}: {
  tasks: readonly Task[];
  onSelect: (task: Task) => void;
  /** Row controls (§3.14): Retry on failed and cancelled tasks, Resume on paused ones. */
  onRetry?: (task: Task) => void;
  onResume?: (task: Task) => void;
  now: number;
}): ReactElement {
  if (tasks.length === 0) {
    return <EmptyState icon={ListChecks}>{t("agent.activity.noTasks")}</EmptyState>;
  }
  return (
    <ul className="flex flex-col" aria-label={t("agent.activity.tasks")}>
      {tasks.map((task) => {
        const step = task.checklist.find((c) => c.status === "in_progress")?.text;
        return (
          <li
            key={task.id}
            className="group/row flex items-center gap-1 rounded-md hover:bg-fill-quaternary"
          >
            <button
              type="button"
              onClick={() => onSelect(task)}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 text-start"
            >
              <StatusGlyph status={TASK_GLYPH[task.status]} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-medium">{task.title}</span>
                <span className="block truncate text-callout text-label-secondary">
                  {step || task.summary
                    ? t("agent.task.statusDetail", {
                        status: TASK_STATUS_LABEL[task.status],
                        detail: step || task.summary || "",
                      })
                    : TASK_STATUS_LABEL[task.status]}
                </span>
              </span>
              <span className="shrink-0 text-end text-callout text-label-secondary">
                {task.createdFrom}
                <br />
                {formatRelative(task.updatedAt, now)}
                {task.leaseOwner && task.leaseOwner !== "local" ? ` · ${task.leaseOwner}` : ""}
              </span>
            </button>
            {onRetry && (task.status === "failed" || task.status === "cancelled") ? (
              <Button
                size="xs"
                variant="ghost"
                className="me-1"
                aria-label={t("agent.activity.retryTask", { title: task.title })}
                onClick={() => onRetry(task)}
              >
                {t("common.retry")}
              </Button>
            ) : null}
            {onResume && task.status === "paused" ? (
              <Button
                size="xs"
                variant="ghost"
                className="me-1"
                aria-label={t("agent.activity.resumeTask", { title: task.title })}
                onClick={() => onResume(task)}
              >
                {t("agent.activity.resume")}
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** One task's action log at the chosen disclosure level (§3.14). */
export function ActionLog({
  actions,
  level,
}: {
  actions: readonly TaskAction[];
  level: DisclosureLevel;
}): ReactElement {
  if (actions.length === 0) {
    return (
      <p className="px-2 py-4 text-body text-label-secondary">{t("agent.activity.noActions")}</p>
    );
  }
  if (level === 0) {
    const last = actions[actions.length - 1];
    return <p className="px-2 py-2 text-body">{last?.level1}</p>;
  }
  return (
    <ol
      className="flex flex-col divide-y divide-separator text-body"
      aria-label={t("agent.activity.actions")}
    >
      {actions.map((a) => (
        <li key={a.id} className="px-2 py-2">
          <div className="flex items-center gap-3">
            <span className="min-w-11 shrink-0 whitespace-nowrap font-mono text-xs text-label-secondary tabular-nums">
              {formatTime(a.createdAt)}
            </span>
            <span className="w-16 shrink-0 truncate text-callout text-label-secondary">
              {a.level2.tool.split(/[._]/)[0]}
            </span>
            <span className="min-w-0 flex-1 truncate">{a.level1}</span>
            {a.level2.outcome ? <Outcome outcome={a.level2.outcome} /> : null}
          </div>
          {level === 2 ? (
            <dl className="mt-1.5 ms-14 grid grid-cols-[5rem_1fr] gap-x-2 rounded-md bg-fill-quaternary p-2 font-mono text-xs">
              <dt className="text-label-secondary">{t("agent.action.tool")}</dt>
              <dd>{a.level2.tool}</dd>
              {a.level2.target ? (
                <>
                  <dt className="text-label-secondary">{t("agent.action.target")}</dt>
                  <dd className="break-all">{a.level2.target}</dd>
                </>
              ) : null}
              {a.level3Ref ? (
                <>
                  <dt className="text-label-secondary">{t("agent.action.raw")}</dt>
                  <dd className="break-all">{a.level3Ref}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function TaskDetail({
  taskId,
  onBack,
  now,
}: {
  taskId: string;
  onBack?: () => void;
  now: number;
}): ReactElement {
  const q = useTask(taskId, { withActions: true });
  const [level, setLevel] = useState<DisclosureLevel>(1);
  if (q.task === null) {
    return q.loading ? (
      <DelayedSkeleton label={t("agent.activity.loading")} className="my-0 h-40 max-w-none" />
    ) : (
      <p className="text-sm text-label-secondary">{t("agent.task.loadFailed")}</p>
    );
  }
  const task = q.task;
  const live = task.status === "running" || task.status === "queued";
  return (
    <section aria-labelledby={`task-${task.id}`} className="flex flex-col gap-4">
      <header className="flex flex-col gap-1 px-2">
        <div className="flex flex-wrap items-center gap-2">
          {onBack ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="-ms-2"
              onClick={onBack}
              aria-label={t("agent.task.back")}
            >
              <ArrowLeft aria-hidden="true" className="rtl:rotate-180" />
            </Button>
          ) : null}
          <StatusGlyph status={TASK_GLYPH[task.status]} />
          <h3 id={`task-${task.id}`} className="min-w-0 flex-1 truncate text-h3">
            {task.title}
          </h3>
          <span className="flex shrink-0 gap-1">
            {live ? (
              <Button size="sm" variant="outline" onClick={() => void q.pause(task.id)}>
                {t("agent.task.pause")}
              </Button>
            ) : null}
            {task.status === "paused" ? (
              <Button size="sm" onClick={() => void q.resume(task.id)}>
                {t("agent.activity.resume")}
              </Button>
            ) : null}
            {task.status === "failed" || task.status === "cancelled" ? (
              <Button size="sm" onClick={() => void q.retry(task.id)}>
                {t("common.retry")}
              </Button>
            ) : null}
            {live || task.status === "paused" || task.status.startsWith("awaiting") ? (
              <Button size="sm" variant="ghost" onClick={() => void q.cancel(task.id)}>
                {t("common.cancel")}
              </Button>
            ) : null}
          </span>
        </div>
        <p className="text-callout text-label-secondary">
          {t("agent.task.meta", {
            from: task.createdFrom,
            time: formatTime(task.createdAt),
            attempt: task.attempt,
            owner: task.leaseOwner && task.leaseOwner !== "local" ? task.leaseOwner : "",
            remote: Boolean(task.leaseOwner && task.leaseOwner !== "local"),
          })}
        </p>
        <p className="text-body text-label-secondary">
          {t("agent.task.updated", {
            status: TASK_STATUS_LABEL[task.status],
            summary: task.summary ?? "",
            hasSummary: Boolean(task.summary),
            when: formatRelative(task.updatedAt, now),
          })}
        </p>
      </header>
      <div className="flex items-center gap-2 px-2 text-body">
        <span className="text-label-secondary" id={`level-${task.id}`}>
          {t("agent.task.level")}
        </span>
        <ToggleGroup
          aria-labelledby={`level-${task.id}`}
          value={[String(level)]}
          onValueChange={(v) => {
            const next = v[0];
            if (next !== undefined) setLevel(Number(next) as DisclosureLevel);
          }}
        >
          {([0, 1, 2] as const).map((l) => (
            <ToggleGroupItem key={l} value={String(l)} size="sm">
              {DISCLOSURE_LABEL[l]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <ActionLog actions={q.actions} level={level} />
    </section>
  );
}

/** A run opened by id: its Task (if any) comes from the run itself. */
export function RunTimelineFor(props: {
  runId: string;
  stepId?: string;
  onBack?: () => void;
  onOpenRun?: (runId: string) => void;
  linkFor?: (runId: string, stepId: string | null) => string;
  now?: number;
}): ReactElement {
  const taskId = useStoreState((s) => s.runs[props.runId]?.taskId ?? null);
  return <RunTimeline {...props} taskId={taskId} />;
}

/**
 * A run's Timeline in Activity (run trace §3.3), with its Task's controls when it has one: Pause
 * and Stop while running, Retry when it failed or was stopped.
 */
export function RunTimeline({
  runId,
  taskId,
  stepId,
  onBack,
  onOpenRun,
  linkFor = (id, step) => agentTimelineHref(id, step ? { stepId: step } : {}),
  now,
}: {
  runId: string;
  taskId?: string | null;
  stepId?: string;
  /** The Back control; the Overview's Timeline page has its own link and passes none. */
  onBack?: () => void;
  /** A helper's own Timeline. */
  onOpenRun?: (runId: string) => void;
  /** The route "Copy link" copies for a run (and step); the sheet's by default. */
  linkFor?: (runId: string, stepId: string | null) => string;
  now?: number;
}): ReactElement {
  const q = useTask(taskId ?? null);
  // A specialist's job gets its own controls: steer, pause or resume, give it more, stop (§4.7).
  const { job } = useSpecialistJob(q.task?.createdFrom === "subagent" ? (taskId ?? null) : null);
  const slots = useSlots();
  const receipts = useStoreState((s) => s.receipts);
  const artifacts = useStoreState((s) => s.artifacts);
  const task = q.task;
  const live = task !== null && (task.status === "running" || task.status === "queued");
  const ended = task !== null && (task.status === "failed" || task.status === "cancelled");
  const navigate = slots.navigate;
  const copy = (text: string) =>
    void (slots.writeClipboard ?? ((x: string) => navigator.clipboard?.writeText(x)))(text);
  return (
    <TimelineView
      runId={runId}
      {...(onBack ? { onBack } : {})}
      onCopyLink={(step) => copy(linkFor(runId, step))}
      {...(navigate
        ? {
            onReconnect: () => navigate("/settings/connectors"),
            onOpenApproval: () => navigate("/agent/approvals"),
            onOpenMemory: (path: string) =>
              navigate(`/agent/soul?file=${encodeURIComponent(path)}`),
          }
        : {})}
      {...(onOpenRun ? { onOpenRun } : {})}
      {...(slots.openReceipt
        ? {
            onOpenReceipt: (id: string) => {
              const r = receipts[id];
              if (r) slots.openReceipt?.(r);
            },
          }
        : {})}
      {...(slots.openArtifact
        ? {
            onOpenArtifact: (id: string) => {
              const a = artifacts[id];
              if (a) slots.openArtifact?.(a);
            },
          }
        : {})}
      {...(stepId ? { initialStepId: stepId } : {})}
      {...(now === undefined ? {} : { now })}
      {...(job ? { controls: <SpecialistControls job={job} /> } : {})}
      {...(task && live && !job ? { onPause: () => void q.pause(task.id) } : {})}
      {...(task && live && !job ? { onStop: () => void q.cancel(task.id) } : {})}
      {...(task && ended ? { onRetry: () => void q.retry(task.id) } : {})}
    />
  );
}

/**
 * A task opened in Activity: its latest run's Timeline, which replaces the old action log
 * (run trace §3.3). A task with no recorded steps (from before the run trace) keeps its log.
 */
function TaskTimeline({
  taskId,
  onBack,
  onOpenRun,
  now,
  fixedNow,
}: {
  taskId: string;
  onBack: () => void;
  onOpenRun: (runId: string) => void;
  now: number;
  fixedNow?: number;
}): ReactElement {
  const list = useRunsList({ taskId, limit: 1 });
  const run = list.runs.find((r) => r.taskId === taskId) ?? null;
  if (run !== null) {
    return (
      <RunTimeline
        runId={run.id}
        taskId={taskId}
        onBack={onBack}
        onOpenRun={onOpenRun}
        {...(fixedNow === undefined ? {} : { now: fixedNow })}
      />
    );
  }
  if (list.loading)
    return <DelayedSkeleton label={t("agent.activity.loading")} className="my-0 h-40 max-w-none" />;
  return <TaskDetail taskId={taskId} onBack={onBack} now={now} />;
}

/** Agent sheet → Activity (§3.14). */
export function ActivityPanel({
  initialTaskId,
  initialRunId,
  initialStepId,
  now: fixedNow,
}: {
  initialTaskId?: string;
  /** Open on a run's Timeline (`/agent/activity/run/:runId`). */
  initialRunId?: string;
  initialStepId?: string;
  now?: number;
}): ReactElement {
  const now = useNow(30_000, fixedNow);
  const tasks = useTasks();
  const [selected, setSelected] = useState<string | null>(initialTaskId ?? null);
  const [run, setRun] = useState<{ runId: string; stepId?: string } | null>(
    initialRunId
      ? { runId: initialRunId, ...(initialStepId ? { stepId: initialStepId } : {}) }
      : null,
  );
  // A new route (`/agent/activity/run/…`) opens that run.
  useEffect(() => {
    if (initialRunId)
      setRun({ runId: initialRunId, ...(initialStepId ? { stepId: initialStepId } : {}) });
  }, [initialRunId, initialStepId]);
  if (run !== null) {
    return (
      <RunTimelineFor
        runId={run.runId}
        {...(run.stepId ? { stepId: run.stepId } : {})}
        onBack={() => setRun(null)}
        onOpenRun={(child) => setRun({ runId: child })}
        {...(fixedNow === undefined ? {} : { now: fixedNow })}
      />
    );
  }
  if (selected !== null) {
    return (
      <TaskTimeline
        taskId={selected}
        onBack={() => setSelected(null)}
        onOpenRun={(child) => setRun({ runId: child })}
        now={now}
        {...(fixedNow === undefined ? {} : { fixedNow })}
      />
    );
  }
  return (
    <section aria-label={t("agent.activity.tasks")} className="flex flex-col gap-3">
      {tasks.error && tasks.all.length === 0 ? (
        <p className="px-2 text-body">
          {t("agent.activity.loadFailed", { reason: tasks.error })}{" "}
          <button type="button" className="text-accent-11 underline" onClick={tasks.reload}>
            {t("agent.activity.tryAgain")}
          </button>
        </p>
      ) : null}
      <MissionControl
        onOpenRun={(runId) => setRun({ runId })}
        tasks={tasks.all}
        onOpenTask={(taskId) => setSelected(taskId)}
        now={now}
      />
      <AuditView {...(fixedNow === undefined ? {} : { now: fixedNow })} />
    </section>
  );
}
