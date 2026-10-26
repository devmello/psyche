import type { Notification, SpecialistJob, SpecialistRole } from "@psyche/protocol";
import { type ReactElement, useId, useState } from "react";
import { toast } from "sonner";
import { StatusGlyph } from "../components/status.tsx";
import { Button } from "../components/ui/button.tsx";
import { useSpecialistJob, useSpecialistRoles } from "../data/specialists.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { formatRelative } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { useSlots } from "../slots.tsx";
import { jobLine, roleGlyph, roleLabel, statusGlyph, statusLabel } from "./model.ts";
import { SpecialistResultCard } from "./ResultCard.tsx";

export interface SpecialistRowProps {
  job: SpecialistJob;
  roles?: readonly SpecialistRole[];
  /** The notification that delivered it (unread dot, time); absent in lists of jobs. */
  notification?: Notification;
  now: number;
  /** Opens on its card (stories). */
  defaultOpen?: boolean;
  onMarkRead?: () => void;
  onNext?: (message: string) => void;
  onOpenThread?: () => void;
  onRetry?: () => void;
  retrying?: boolean;
}

/**
 * A specialist job as an Inbox row (docs/agent/specialists-2026.md §6.2): the role glyph and the
 * title, then "Done · 3 findings · $0.84 · 22 min". A finished job opens in place on its result
 * card. Presentational.
 */
export function SpecialistRow({
  job,
  roles,
  notification: n,
  now,
  defaultOpen = false,
  onMarkRead,
  onNext,
  onOpenThread,
  onRetry,
  retrying,
}: SpecialistRowProps): ReactElement {
  const titleId = useId();
  const cardId = useId();
  const [open, setOpen] = useState(defaultOpen);
  const role = roles?.find((r) => r.role === job.role);
  const label = roleLabel(job.role, roles);
  const Glyph = roleGlyph(job.role);
  const unread = n !== undefined && n.readAt == null;
  const hasCard = job.result != null;
  return (
    <article
      aria-labelledby={titleId}
      data-unread={unread || undefined}
      data-testid="specialist-row"
      className={cn(
        "relative flex flex-col gap-3 px-3 py-2 text-body",
        "before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator",
      )}
    >
      <div className="flex min-h-11 items-start gap-3">
        <span className="-ms-1 flex h-5 w-3 shrink-0 items-center justify-center">
          {unread ? <span className="size-2 rounded-full bg-accent-9" aria-hidden="true" /> : null}
        </span>
        <span className="flex h-5 shrink-0 items-center" aria-hidden="true">
          <Glyph className="size-4 text-label-secondary" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3
            id={titleId}
            className={cn(
              "text-headline text-label-primary",
              unread ? "font-semibold" : "font-normal",
            )}
          >
            <span className="sr-only">{label}: </span>
            {job.title}
          </h3>
          <p className="flex min-w-0 items-center gap-1.5 text-callout text-label-secondary">
            <StatusGlyph
              status={statusGlyph(job.status)}
              label={statusLabel(job.status)}
              className="[&_svg]:size-3.5"
            />
            <span className="min-w-0 truncate tabular-nums">{jobLine(job, role?.result)}</span>
          </p>
          <p className="flex flex-wrap items-center gap-x-1.5 text-subheadline text-label-tertiary">
            <span className="font-medium">{label}</span>
            <span aria-hidden="true">·</span>
            <span>{formatRelative(n?.createdAt ?? job.updatedAt, now)}</span>
            {unread ? <span className="sr-only">{t("screens.inbox.unread")}</span> : null}
          </p>
        </div>
        {hasCard ? (
          <div className="flex items-center self-center">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-expanded={open}
              aria-controls={cardId}
              onClick={() => {
                setOpen((v) => !v);
                if (unread) onMarkRead?.();
              }}
            >
              {open ? t("specialists.action.hide") : t("specialists.action.open")}
            </Button>
          </div>
        ) : null}
      </div>
      {hasCard && open ? (
        <div id={cardId} className="ps-11 pb-2">
          <SpecialistResultCard
            job={job}
            roleLabel={label}
            {...(role ? { resultKind: role.result } : {})}
            {...(onNext ? { onNext } : {})}
            {...(onOpenThread ? { onOpenThread } : {})}
            {...(onRetry ? { onRetry } : {})}
            {...(retrying === undefined ? {} : { retrying })}
          />
        </div>
      ) : null}
    </article>
  );
}

/**
 * Wires a job's actions: follow-ups go to the parent thread's composer, Open thread opens the
 * job's own thread, Retry runs `tasks.retry`.
 */
export function useSpecialistActions(job: SpecialistJob | null): {
  onNext: (message: string) => void;
  onOpenThread: () => void;
  onRetry: () => void;
  retrying: boolean;
} {
  const { navigate, prefillComposer } = useSlots();
  const { retry } = useSpecialistJob(job?.taskId ?? null);
  const [retrying, setRetrying] = useState(false);
  return {
    onNext: (message) => {
      if (job === null) return;
      navigate?.(`/chat/${job.parentThreadId}`);
      prefillComposer?.(message);
    },
    onOpenThread: () => {
      if (job !== null) navigate?.(`/chat/${job.threadId}`);
    },
    onRetry: () => {
      if (job === null) return;
      setRetrying(true);
      retry()
        .catch((err: unknown) => {
          toast.error(
            t("specialists.retryFailed", { title: job.title, reason: describeError(err) }),
          );
        })
        .finally(() => setRetrying(false));
    },
    retrying,
  };
}

/** The Inbox's row for a `specialist_result` notification, with its job and actions. */
export function SpecialistInboxRow({
  notification,
  now,
  onMarkRead,
  fallback,
}: {
  notification: Notification;
  now: number;
  onMarkRead?: () => void;
  /** Rendered while the job is unknown (not loaded, or gone). */
  fallback: ReactElement;
}): ReactElement {
  const { job } = useSpecialistJob(notification.taskId ?? null);
  const { roles } = useSpecialistRoles();
  const actions = useSpecialistActions(job);
  if (job === null) return fallback;
  return (
    <SpecialistRow
      job={job}
      roles={roles}
      notification={notification}
      now={now}
      {...(onMarkRead ? { onMarkRead } : {})}
      {...actions}
    />
  );
}
