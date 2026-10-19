import type { Task, TaskStatus } from "@psyche/protocol";
import { CircleAlert, CircleCheck, CirclePause, CircleX, Hand, Loader } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import { cn } from "../lib/utils.ts";
import { Checklist } from "./Checklist.tsx";

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "queued",
  running: "running",
  awaiting_input: "needs your answer",
  awaiting_approval: "awaiting approval",
  paused: "paused",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

export function TaskStatusIcon({ status }: { status: TaskStatus }): ReactElement {
  const cls = "size-4 shrink-0";
  switch (status) {
    case "running":
    case "queued":
      return (
        <Loader className={cn(cls, "text-accent-11 motion-safe:animate-spin")} aria-hidden="true" />
      );
    case "awaiting_approval":
    case "awaiting_input":
      return <Hand className={cn(cls, "text-approval-text")} aria-hidden="true" />;
    case "paused":
      return <CirclePause className={cn(cls, "text-gray-11")} aria-hidden="true" />;
    case "done":
      return <CircleCheck className={cn(cls, "text-success")} aria-hidden="true" />;
    case "failed":
      return <CircleAlert className={cn(cls, "text-danger")} aria-hidden="true" />;
    case "cancelled":
      return <CircleX className={cn(cls, "text-gray-9")} aria-hidden="true" />;
  }
}

export interface TaskCardProps {
  task: Task;
  onOpen?: (task: Task) => void;
  onPause?: (task: Task) => void;
  onResume?: (task: Task) => void;
  onCancel?: (task: Task) => void;
  onRetry?: (task: Task) => void;
}

/** Task block with live status (UI design §3.2, §3.14). */
export function TaskCard({
  task,
  onOpen,
  onPause,
  onResume,
  onCancel,
  onRetry,
}: TaskCardProps): ReactElement {
  const live = task.status === "running" || task.status === "queued";
  const current = task.checklist.find((c) => c.status === "in_progress");
  return (
    <section
      aria-label={`Task ${task.title}, ${TASK_STATUS_LABEL[task.status]}`}
      className="my-2 rounded-lg border border-gray-6 bg-gray-2 p-3 psy-enter"
    >
      <header className="flex items-center gap-2">
        <TaskStatusIcon status={task.status} />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{task.title}</h3>
        <span className="text-xs text-muted-foreground" aria-live={live ? "polite" : undefined}>
          {TASK_STATUS_LABEL[task.status]}
          {current ? ` · ${current.text}` : ""}
        </span>
      </header>
      {task.summary ? <p className="mt-1 text-sm text-gray-11">{task.summary}</p> : null}
      {task.checklist.length > 0 ? <Checklist items={task.checklist} /> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {onOpen ? (
          <Button size="sm" variant="outline" onClick={() => onOpen(task)}>
            Open activity
          </Button>
        ) : null}
        {live && onPause ? (
          <Button size="sm" variant="ghost" onClick={() => onPause(task)}>
            Pause
          </Button>
        ) : null}
        {task.status === "paused" && onResume ? (
          <Button size="sm" variant="ghost" onClick={() => onResume(task)}>
            Resume
          </Button>
        ) : null}
        {(live || task.status === "paused") && onCancel ? (
          <Button size="sm" variant="ghost" onClick={() => onCancel(task)}>
            Cancel
          </Button>
        ) : null}
        {(task.status === "failed" || task.status === "cancelled") && onRetry ? (
          <Button size="sm" variant="ghost" onClick={() => onRetry(task)}>
            Retry
          </Button>
        ) : null}
      </div>
    </section>
  );
}
