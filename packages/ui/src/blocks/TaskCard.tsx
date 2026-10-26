import type { Task, TaskStatus } from "@psyche/protocol";
import { CircleAlert, CircleCheck, CirclePause, CircleX, Hand, Loader } from "lucide-react";
import type { ReactElement } from "react";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { Checklist } from "./Checklist.tsx";
import { Card, type CardAction, fromTaskStatus } from "./card.tsx";

const TASK_STATUSES: readonly TaskStatus[] = [
  "queued",
  "running",
  "awaiting_input",
  "awaiting_approval",
  "paused",
  "done",
  "failed",
  "cancelled",
];

/** A task status as shown, from the catalogue (each entry is read at use). */
export const TASK_STATUS_LABEL: Readonly<Record<TaskStatus, string>> = Object.defineProperties(
  {} as Record<TaskStatus, string>,
  Object.fromEntries(
    TASK_STATUSES.map((s) => [s, { enumerable: true, get: () => t(`blocks.task.status.${s}`) }]),
  ),
);

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

/** Task block with live status (UI design §3.2, §3.14), on the card shell. */
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
  const failed = task.status === "failed" || task.status === "cancelled";
  const actions: CardAction[] = [];
  if (live && onPause)
    actions.push({
      id: "pause",
      label: t("blocks.task.pause"),
      kind: "send",
      onSelect: () => onPause(task),
    });
  if (task.status === "paused" && onResume)
    actions.push({
      id: "resume",
      label: t("blocks.task.resume"),
      kind: "send",
      onSelect: () => onResume(task),
    });
  if ((live || task.status === "paused") && onCancel)
    actions.push({
      id: "cancel",
      label: t("common.cancel"),
      kind: "send",
      onSelect: () => onCancel(task),
    });
  if (failed && onRetry)
    actions.push({
      id: "retry",
      label: t("common.retry"),
      kind: "send",
      primary: true,
      onSelect: () => onRetry(task),
    });
  if (onOpen)
    actions.push({
      id: "open",
      label: t("blocks.task.openActivity"),
      kind: "open",
      primary: !(failed && onRetry),
      onSelect: () => onOpen(task),
    });
  return (
    <Card
      label={t("blocks.task.label", { title: task.title, status: TASK_STATUS_LABEL[task.status] })}
      status={fromTaskStatus(task.status)}
      title={task.title}
      meta={`${TASK_STATUS_LABEL[task.status]}${current ? ` · ${current.text}` : ""}`}
      live={live}
      actions={actions}
      createdAt={task.createdAt}
    >
      {task.summary ? <p className="text-body text-label-secondary">{task.summary}</p> : null}
      {task.checklist.length > 0 ? <Checklist items={task.checklist} /> : null}
    </Card>
  );
}
