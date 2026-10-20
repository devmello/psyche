import type { Task, TaskAction } from "@psyche/protocol";
import { ArrowLeft, ListChecks } from "lucide-react";
import { type ReactElement, useState } from "react";
import { DISCLOSURE_LABEL, type DisclosureLevel } from "../blocks/disclosure.tsx";
import { TASK_STATUS_LABEL, TaskStatusIcon } from "../blocks/TaskCard.tsx";
import { EmptyState } from "../components/page.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.tsx";
import { useTask, useTasks } from "../data/index.ts";
import { formatRelative, formatTime } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";

type Filter = "running" | "needs-you" | "all";

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
        <span className="text-caption text-muted-foreground">{rest.join(" · ")}</span>
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
    return <EmptyState icon={ListChecks}>No tasks yet.</EmptyState>;
  }
  return (
    <ul className="flex flex-col" aria-label="Tasks">
      {tasks.map((t) => {
        const step = t.checklist.find((c) => c.status === "in_progress")?.text;
        return (
          <li key={t.id} className="group/row flex items-center gap-1 rounded-md hover:bg-gray-3">
            <button
              type="button"
              onClick={() => onSelect(t)}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 text-left"
            >
              <TaskStatusIcon status={t.status} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-small font-medium">{t.title}</span>
                <span className="block truncate text-caption text-muted-foreground">
                  {TASK_STATUS_LABEL[t.status]}
                  {step ? ` · ${step}` : t.summary ? ` · ${t.summary}` : ""}
                </span>
              </span>
              <span className="shrink-0 text-right text-caption text-muted-foreground">
                {t.createdFrom}
                <br />
                {formatRelative(t.updatedAt, now)}
                {t.leaseOwner && t.leaseOwner !== "local" ? ` · ${t.leaseOwner}` : ""}
              </span>
            </button>
            {onRetry && (t.status === "failed" || t.status === "cancelled") ? (
              <Button
                size="xs"
                variant="ghost"
                className="mr-1"
                aria-label={`Retry ${t.title}`}
                onClick={() => onRetry(t)}
              >
                Retry
              </Button>
            ) : null}
            {onResume && t.status === "paused" ? (
              <Button
                size="xs"
                variant="ghost"
                className="mr-1"
                aria-label={`Resume ${t.title}`}
                onClick={() => onResume(t)}
              >
                Resume
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
    return <p className="px-2 py-4 text-small text-muted-foreground">No actions yet.</p>;
  }
  if (level === 0) {
    const last = actions[actions.length - 1];
    return <p className="px-2 py-2 text-small">{last?.level1}</p>;
  }
  return (
    <ol className="flex flex-col divide-y divide-gray-4 text-small" aria-label="Actions">
      {actions.map((a) => (
        <li key={a.id} className="px-2 py-2">
          <div className="flex items-center gap-3">
            <span className="w-11 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
              {formatTime(a.createdAt)}
            </span>
            <span className="w-16 shrink-0 truncate text-caption text-gray-11">
              {a.level2.tool.split(/[._]/)[0]}
            </span>
            <span className="min-w-0 flex-1 truncate">{a.level1}</span>
            {a.level2.outcome ? <Outcome outcome={a.level2.outcome} /> : null}
          </div>
          {level === 2 ? (
            <dl className="mt-1.5 ml-14 grid grid-cols-[5rem_1fr] gap-x-2 rounded-md bg-gray-2 p-2 font-mono text-xs">
              <dt className="text-muted-foreground">tool</dt>
              <dd>{a.level2.tool}</dd>
              {a.level2.target ? (
                <>
                  <dt className="text-muted-foreground">target</dt>
                  <dd className="break-all">{a.level2.target}</dd>
                </>
              ) : null}
              {a.level3Ref ? (
                <>
                  <dt className="text-muted-foreground">raw</dt>
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
  const t = useTask(taskId, { withActions: true });
  const [level, setLevel] = useState<DisclosureLevel>(1);
  if (t.task === null) {
    return t.loading ? (
      <Skeleton className="h-40" />
    ) : (
      <p className="text-sm text-muted-foreground">Psyche couldn't load this task.</p>
    );
  }
  const task = t.task;
  const live = task.status === "running" || task.status === "queued";
  return (
    <section aria-labelledby={`task-${task.id}`} className="flex flex-col gap-4">
      <header className="flex flex-col gap-1 px-2">
        <div className="flex flex-wrap items-center gap-2">
          {onBack ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="-ml-2"
              onClick={onBack}
              aria-label="Back to tasks"
            >
              <ArrowLeft aria-hidden="true" />
            </Button>
          ) : null}
          <TaskStatusIcon status={task.status} />
          <h3 id={`task-${task.id}`} className="min-w-0 flex-1 truncate text-h3">
            {task.title}
          </h3>
          <span className="flex shrink-0 gap-1">
            {live ? (
              <Button size="sm" variant="outline" onClick={() => void t.pause(task.id)}>
                Pause
              </Button>
            ) : null}
            {task.status === "paused" ? (
              <Button size="sm" onClick={() => void t.resume(task.id)}>
                Resume
              </Button>
            ) : null}
            {task.status === "failed" || task.status === "cancelled" ? (
              <Button size="sm" onClick={() => void t.retry(task.id)}>
                Retry
              </Button>
            ) : null}
            {live || task.status === "paused" || task.status.startsWith("awaiting") ? (
              <Button size="sm" variant="ghost" onClick={() => void t.cancel(task.id)}>
                Cancel
              </Button>
            ) : null}
          </span>
        </div>
        <p className="text-caption text-muted-foreground">
          from {task.createdFrom} · {formatTime(task.createdAt)} · attempt {task.attempt}
          {task.leaseOwner && task.leaseOwner !== "local" ? ` · on ${task.leaseOwner}` : ""}
        </p>
        <p className="text-small text-gray-11">
          {TASK_STATUS_LABEL[task.status]}
          {task.summary ? ` · ${task.summary}` : ""} · updated {formatRelative(task.updatedAt, now)}
        </p>
      </header>
      <div className="flex items-center gap-2 px-2 text-small">
        <span className="text-muted-foreground" id={`level-${task.id}`}>
          Level
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
      <ActionLog actions={t.actions} level={level} />
    </section>
  );
}

/** Agent sheet → Activity (§3.14). */
export function ActivityPanel({
  initialTaskId,
  now: fixedNow,
}: {
  initialTaskId?: string;
  now?: number;
}): ReactElement {
  const now = useNow(30_000, fixedNow);
  const tasks = useTasks();
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(initialTaskId ?? null);
  if (selected !== null) {
    return <TaskDetail taskId={selected} onBack={() => setSelected(null)} now={now} />;
  }
  const shown =
    filter === "running" ? tasks.running : filter === "needs-you" ? tasks.needsYou : tasks.all;
  return (
    <section aria-label="Activity" className="flex flex-col gap-3">
      <ToggleGroup
        aria-label="Filter tasks"
        value={[filter]}
        onValueChange={(v) => {
          const next = v[0];
          if (next !== undefined) setFilter(next as Filter);
        }}
      >
        <ToggleGroupItem value="running" size="sm">
          Running {tasks.running.length}
        </ToggleGroupItem>
        <ToggleGroupItem value="needs-you" size="sm">
          Needs you {tasks.needsYou.length}
        </ToggleGroupItem>
        <ToggleGroupItem value="all" size="sm">
          All
        </ToggleGroupItem>
      </ToggleGroup>
      {tasks.loading && tasks.all.length === 0 ? (
        <div className="flex flex-col gap-2" role="status" aria-label="Loading tasks">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : tasks.error && tasks.all.length === 0 ? (
        <p className="px-2 text-small">
          Psyche couldn't load tasks ({tasks.error}).{" "}
          <button type="button" className="text-accent-11 underline" onClick={tasks.reload}>
            Try again
          </button>
        </p>
      ) : (
        <TaskList
          tasks={shown}
          onSelect={(t) => setSelected(t.id)}
          onRetry={(t) => void tasks.retry(t.id)}
          onResume={(t) => void tasks.resume(t.id)}
          now={now}
        />
      )}
    </section>
  );
}
