import type { ApprovalRequest, Notification, NotificationKind } from "@psyche/protocol";
import {
  Bell,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  Info,
  Lightbulb,
  type LucideIcon,
  Newspaper,
} from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "../../components/ui/button.tsx";
import { useApproval, useNotifications, useTask } from "../../data/hooks.ts";
import { formatCountdown, formatRelative, plural } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { cn } from "../../lib/utils.ts";
import { useSlots } from "../../slots.tsx";
import {
  EmptyState,
  ErrorState,
  LoadingCards,
  ScreenHeader,
  useDelayedFlag,
} from "../feed/states.tsx";

export const NOTIFICATION_KIND: Record<
  NotificationKind,
  { label: string; icon: LucideIcon; tone: string }
> = {
  approval: { label: "Approval", icon: CircleAlert, tone: "text-approval-text" },
  input_needed: { label: "Input", icon: CircleHelp, tone: "text-approval-text" },
  task_done: { label: "Done", icon: CircleCheck, tone: "text-success-text" },
  task_failed: { label: "Failed", icon: CircleX, tone: "text-danger-text" },
  proactive: { label: "Idea", icon: Lightbulb, tone: "text-accent-11" },
  briefing: { label: "Brief", icon: Newspaper, tone: "text-accent-11" },
  reminder: { label: "Reminder", icon: Bell, tone: "text-info-text" },
  system: { label: "System", icon: Info, tone: "text-info-text" },
};

/** What the row knows about the approval behind an `approval` notification. */
export interface InboxApprovalState {
  approval: ApprovalRequest | null;
  canAnswer: boolean;
  stale: boolean;
}

export interface InboxRowProps {
  notification: Notification;
  now: number;
  /** Forces the stale marking; rows are also stale when the Gateway set `staleAt` (§3.20). */
  stale?: boolean;
  approval?: InboxApprovalState;
  busy?: boolean;
  onApprove?: (n: Notification) => void;
  onDeny?: (n: Notification) => void;
  /** Opens `notification.route` (Answer, Open, Open card). */
  onOpen?: (n: Notification) => void;
  onRetry?: (n: Notification) => void;
  /** Resolves with one of the notification's own actions (Done, Snooze). */
  onAction?: (n: Notification, actionId: string) => void;
  onMarkRead?: (n: Notification) => void;
}

const DECIDED: Partial<Record<ApprovalRequest["status"], string>> = {
  approved: "Approved",
  denied: "Denied",
  expired: "Expired. Nothing was done.",
  invalidated: "Voided",
};

function ApprovalControls({
  n,
  state,
  now,
  busy,
  onApprove,
  onDeny,
  onOpen,
}: {
  n: Notification;
  state: InboxApprovalState | undefined;
  now: number;
  busy: boolean;
  onApprove?: (n: Notification) => void;
  onDeny?: (n: Notification) => void;
  onOpen?: (n: Notification) => void;
}): ReactElement {
  // Inline buttons arm 400 ms after they appear, like the full card (UI design §3.3).
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), 400);
    return () => clearTimeout(t);
  }, []);
  const openCard = (
    <Button type="button" size="sm" variant="outline" onClick={() => onOpen?.(n)}>
      Open card
    </Button>
  );
  const a = state?.approval ?? null;
  if (a === null) return openCard;
  if (a.status !== "pending") {
    return <span className="text-xs text-muted-foreground">{DECIDED[a.status] ?? a.status}</span>;
  }
  const remaining = Date.parse(a.expiresAt) - now;
  if (remaining <= 0) {
    return <span className="text-xs text-muted-foreground">Expired. Nothing was done.</span>;
  }
  const countdown = (
    <span
      className={cn(
        "text-xs tabular-nums",
        remaining < 60_000 ? "font-semibold text-danger-text" : "text-muted-foreground",
      )}
    >
      <span className="sr-only">Expires in </span>
      {formatCountdown(remaining)}
    </span>
  );
  // Purchases and fills always open the full card (§3.20), whatever their flags say; so do
  // device-only and authentication-required kinds.
  const inline =
    a.kind !== "purchase" &&
    a.kind !== "credential_fill" &&
    !a.deviceOnly &&
    !a.requiresAuthentication &&
    state?.canAnswer &&
    !state.stale;
  return (
    <>
      {countdown}
      {inline ? (
        <>
          <Button
            type="button"
            size="sm"
            disabled={busy || !armed}
            onClick={() => onApprove?.(n)}
            aria-label={`Approve once: ${a.summary}`}
          >
            Approve
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy || !armed}
            onClick={() => onDeny?.(n)}
            aria-label={`Deny: ${a.summary}`}
          >
            Deny
          </Button>
        </>
      ) : (
        openCard
      )}
    </>
  );
}

/** One inbox row: kind icon and label, title, body, countdown and inline actions (§3.20). */
export function InboxRow({
  notification: n,
  now,
  stale = false,
  approval,
  busy = false,
  onApprove,
  onDeny,
  onOpen,
  onRetry,
  onAction,
  onMarkRead,
}: InboxRowProps): ReactElement {
  const titleId = useId();
  const kind = NOTIFICATION_KIND[n.kind];
  const Icon = kind.icon;
  const unread = n.readAt == null;
  const resolved = n.resolvedAt != null;
  const isStale = stale || n.staleAt != null || (n.kind === "approval" && approval?.stale === true);

  let actions: ReactNode = null;
  if (n.kind === "approval") {
    actions = (
      <ApprovalControls
        n={n}
        state={approval}
        now={now}
        busy={busy}
        {...(onApprove ? { onApprove } : {})}
        {...(onDeny ? { onDeny } : {})}
        {...(onOpen ? { onOpen } : {})}
      />
    );
  } else if (resolved) {
    actions = <span className="text-xs text-muted-foreground">Resolved</span>;
  } else if (n.kind === "input_needed") {
    actions = (
      <Button type="button" size="sm" onClick={() => onOpen?.(n)} disabled={n.route == null}>
        Answer
      </Button>
    );
  } else if (n.kind === "task_failed") {
    actions = (
      <>
        <Button type="button" size="sm" variant="outline" onClick={() => onOpen?.(n)}>
          Open
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || n.taskId == null}
          onClick={() => onRetry?.(n)}
        >
          Retry
        </Button>
      </>
    );
  } else if (n.kind === "reminder" && n.actions.length > 0) {
    actions = n.actions.map((a) => (
      <Button
        key={a.id}
        type="button"
        size="sm"
        variant={a.destructive ? "destructive" : "outline"}
        disabled={busy}
        onClick={() => onAction?.(n, a.id)}
      >
        {a.label}
      </Button>
    ));
  } else if (n.route != null) {
    actions = (
      <Button type="button" size="sm" variant="outline" onClick={() => onOpen?.(n)}>
        Open
      </Button>
    );
  }

  return (
    <article
      aria-labelledby={titleId}
      data-unread={unread || undefined}
      className={cn(
        "flex flex-wrap items-start gap-3 border-b border-gray-6 px-2 py-3 text-sm",
        unread ? "bg-accent-2" : "",
        resolved || isStale ? "opacity-75" : "",
      )}
    >
      <span
        className={cn(
          "mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-gray-3",
          kind.tone,
        )}
        aria-hidden="true"
      >
        <Icon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span className={cn("font-semibold uppercase", kind.tone)}>{kind.label}</span>
          <span>{formatRelative(n.createdAt, now)}</span>
          {unread ? (
            <span className="inline-flex items-center gap-1 font-medium text-accent-11">
              <span className="size-1.5 rounded-full bg-accent-9" aria-hidden="true" />
              Unread
            </span>
          ) : null}
          {isStale ? (
            <span className="font-medium text-approval-text">
              Stale · {n.staleReason ?? "sent before Psyche restarted"}
            </span>
          ) : null}
        </p>
        <h2 id={titleId} className={cn("text-sm", unread ? "font-semibold" : "font-normal")}>
          {n.title}
        </h2>
        {n.body ? <p className="text-gray-11">{n.body}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 self-center">
        {actions}
        {unread && onMarkRead ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Mark "${n.title}" read`}
            onClick={() => onMarkRead(n)}
          >
            Mark read
          </Button>
        ) : null}
      </div>
    </article>
  );
}

export interface InboxViewProps {
  notifications: readonly Notification[];
  now: number;
  loading?: boolean;
  loadingDelayMs?: number;
  error?: string | null;
  onRetryLoad?: () => void;
  onMarkAllRead?: () => void;
  /** The empty state's one action. */
  onOpenActivity?: () => void;
  /** Renders a row; defaults to a plain `InboxRow` (no Gateway). */
  renderRow?: (n: Notification) => ReactNode;
  rowProps?: Omit<InboxRowProps, "notification" | "now">;
}

/** Notification inbox (UI design §3.20). Presentational. */
export function InboxView({
  notifications,
  now,
  loading = false,
  loadingDelayMs = 0,
  error = null,
  onRetryLoad,
  onMarkAllRead,
  onOpenActivity,
  renderRow,
  rowProps,
}: InboxViewProps): ReactElement {
  const showSkeleton = useDelayedFlag(loading, loadingDelayMs);
  const unread = notifications.filter((n) => n.readAt == null).length;

  let body: ReactElement;
  if (loading) {
    body = showSkeleton ? (
      <LoadingCards label="Loading the inbox" count={4} lines={1} layout="rows" />
    ) : (
      <div aria-busy="true" className="min-h-24" />
    );
  } else if (error !== null) {
    body = (
      <ErrorState
        what="Psyche couldn't load the inbox"
        reason={error}
        did="Approvals still reach your other devices."
        {...(onRetryLoad ? { retry: { onClick: onRetryLoad } } : {})}
      />
    );
  } else if (notifications.length === 0) {
    body = (
      <EmptyState
        {...(onOpenActivity ? { action: { label: "Open Activity", onClick: onOpenActivity } } : {})}
      >
        Nothing needs you.
      </EmptyState>
    );
  } else {
    body = (
      <ul aria-label="Notifications" className="flex flex-col">
        {notifications.map((n) => (
          <li key={n.id}>
            {renderRow ? renderRow(n) : <InboxRow notification={n} now={now} {...rowProps} />}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section aria-label="Inbox" className="mx-auto flex max-w-[80ch] flex-col gap-3 p-4">
      <ScreenHeader
        title="Inbox"
        meta={
          !loading && error === null && unread > 0 ? `${plural(unread, "unread", "unread")}` : null
        }
        {...(unread > 0 && onMarkAllRead
          ? {
              actions: (
                <Button type="button" size="sm" variant="ghost" onClick={onMarkAllRead}>
                  Mark all read
                </Button>
              ),
            }
          : {})}
      />
      {body}
    </section>
  );
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface ConnectedRowProps {
  notification: Notification;
  now: number;
  markRead: (ids: string[]) => Promise<unknown>;
  resolve: (id: string, actionId?: string) => Promise<unknown>;
  open: (n: Notification) => void;
}

/** A row with its approval (`useApproval`) and task retry (`useTask`) wired in. */
function ConnectedInboxRow({
  notification: n,
  now,
  markRead,
  resolve,
  open,
}: ConnectedRowProps): ReactElement {
  const ap = useApproval(n.kind === "approval" ? (n.approvalId ?? null) : null);
  const { retry } = useTask(null);
  const [busy, setBusy] = useState(false);
  const run = (work: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    work()
      .catch((err: unknown) => {
        toast.error(`${failure} (${messageOf(err)}).`);
      })
      .finally(() => setBusy(false));
  };
  const read = () => {
    if (n.readAt == null) void markRead([n.id]).catch(() => {});
  };
  return (
    <InboxRow
      notification={n}
      now={now}
      busy={busy}
      approval={{ approval: ap.approval, canAnswer: ap.canAnswer, stale: ap.stale }}
      onApprove={() => {
        read();
        run(() => ap.answer("approve", "once"), "Psyche couldn't send the approval");
      }}
      onDeny={() => {
        read();
        run(() => ap.answer("deny"), "Psyche couldn't send the denial");
      }}
      onOpen={(x) => {
        read();
        open(x);
      }}
      onRetry={(x) => {
        const taskId = x.taskId;
        if (taskId == null) return;
        read();
        run(
          () => retry(taskId).then(() => resolve(x.id, "retry")),
          `Psyche couldn't retry "${x.title}"`,
        );
      }}
      onAction={(x, actionId) => run(() => resolve(x.id, actionId), "Psyche couldn't save that")}
      onMarkRead={read}
    />
  );
}

export interface InboxScreenProps {
  /** Fixed clock (stories, tests). */
  now?: number;
  /** Defaults to `navigate(notification.route)`; approvals fall back to `/agent/approvals`. */
  onOpen?: (n: Notification) => void;
}

/** Connected inbox: `notifications.*`, `approvals.answer` (scope once), `tasks.retry`. */
export function InboxScreen({ now: fixedNow, onOpen }: InboxScreenProps): ReactElement {
  const { navigate } = useSlots();
  const now = useNow(1000, fixedNow);
  const inbox = useNotifications();
  const open =
    onOpen ??
    ((n: Notification) => {
      const route = n.route ?? (n.kind === "approval" ? "/agent/approvals" : null);
      if (route !== null) navigate?.(route);
    });

  return (
    <InboxView
      notifications={inbox.all}
      now={now}
      loading={inbox.loading && inbox.all.length === 0}
      loadingDelayMs={150}
      error={inbox.all.length === 0 ? inbox.error : null}
      onRetryLoad={inbox.reload}
      onMarkAllRead={() => {
        const ids = inbox.unread.map((n) => n.id);
        if (ids.length > 0)
          inbox.markRead(ids).catch((err: unknown) => {
            toast.error(`Psyche couldn't mark these read (${messageOf(err)}).`);
          });
      }}
      onOpenActivity={() => navigate?.("/agent/activity")}
      renderRow={(n) => (
        <ConnectedInboxRow
          notification={n}
          now={now}
          markRead={inbox.markRead}
          resolve={inbox.resolve}
          open={open}
        />
      )}
    />
  );
}
