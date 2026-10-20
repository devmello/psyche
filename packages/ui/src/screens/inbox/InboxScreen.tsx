import type { ApprovalRequest, Notification, NotificationKind } from "@psyche/protocol";
import {
  Bell,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  Inbox,
  Info,
  Lightbulb,
  type LucideIcon,
  Newspaper,
} from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import {
  EmptyState,
  ErrorState,
  LoadingCards,
  Page,
  PageHeader,
  useDelayedFlag,
} from "../../components/page.tsx";
import { Button } from "../../components/ui/button.tsx";
import { useApproval, useNotifications, useTask } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { formatCountdown, formatRelative } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { cn } from "../../lib/utils.ts";
import { useSlots } from "../../slots.tsx";

/** Semantic tones only (§4.8): approval, success, danger, info, or neutral gray. */
const TONE = {
  approval: "bg-amber-3 text-approval-text",
  success: "bg-grass-3 text-grass-11",
  danger: "bg-tomato-3 text-tomato-12 dark:text-tomato-11",
  info: "bg-sky-3 text-sky-11",
  muted: "bg-gray-3 text-gray-11",
} as const;

export const NOTIFICATION_KIND: Record<
  NotificationKind,
  { label: string; icon: LucideIcon; tone: string }
> = {
  approval: {
    get label() {
      return t("screens.inbox.kind.approval");
    },
    icon: CircleAlert,
    tone: TONE.approval,
  },
  input_needed: {
    get label() {
      return t("screens.inbox.kind.input_needed");
    },
    icon: CircleHelp,
    tone: TONE.approval,
  },
  task_done: {
    get label() {
      return t("screens.inbox.kind.task_done");
    },
    icon: CircleCheck,
    tone: TONE.success,
  },
  task_failed: {
    get label() {
      return t("screens.inbox.kind.task_failed");
    },
    icon: CircleX,
    tone: TONE.danger,
  },
  proactive: {
    get label() {
      return t("screens.inbox.kind.proactive");
    },
    icon: Lightbulb,
    tone: TONE.muted,
  },
  briefing: {
    get label() {
      return t("screens.inbox.kind.briefing");
    },
    icon: Newspaper,
    tone: TONE.muted,
  },
  reminder: {
    get label() {
      return t("screens.inbox.kind.reminder");
    },
    icon: Bell,
    tone: TONE.info,
  },
  system: {
    get label() {
      return t("screens.inbox.kind.system");
    },
    icon: Info,
    tone: TONE.muted,
  },
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
  get approved() {
    return t("screens.inbox.decided.approved");
  },
  get denied() {
    return t("screens.inbox.decided.denied");
  },
  get expired() {
    return t("screens.inbox.decided.expired");
  },
  get invalidated() {
    return t("screens.inbox.decided.invalidated");
  },
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
    const timer = setTimeout(() => setArmed(true), 400);
    return () => clearTimeout(timer);
  }, []);
  const openCard = (
    <Button type="button" size="sm" variant="ghost" onClick={() => onOpen?.(n)}>
      {t("screens.inbox.openCard")}
    </Button>
  );
  const a = state?.approval ?? null;
  if (a === null) return openCard;
  if (a.status !== "pending") {
    return <span className="text-caption text-gray-11">{DECIDED[a.status] ?? a.status}</span>;
  }
  const remaining = Date.parse(a.expiresAt) - now;
  if (remaining <= 0) {
    return <span className="text-caption text-gray-11">{t("screens.inbox.decided.expired")}</span>;
  }
  const countdown = (
    <span
      className={cn(
        "me-1 text-caption tabular-nums",
        remaining < 60_000 ? "font-semibold text-danger-text" : "text-gray-11",
      )}
    >
      <span className="sr-only">{t("screens.inbox.expiresIn")} </span>
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
          {/* Deny sits left of Approve, as on the approval card (§3.3). */}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !armed}
            onClick={() => onDeny?.(n)}
            aria-label={t("screens.inbox.denyLabel", { summary: a.summary })}
          >
            {t("screens.inbox.deny")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy || !armed}
            onClick={() => onApprove?.(n)}
            aria-label={t("screens.inbox.approveLabel", { summary: a.summary })}
          >
            {t("screens.inbox.approve")}
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
    actions = <span className="text-caption text-gray-11">{t("screens.inbox.resolved")}</span>;
  } else if (n.kind === "input_needed") {
    actions = (
      <Button type="button" size="sm" onClick={() => onOpen?.(n)} disabled={n.route == null}>
        {t("screens.inbox.answer")}
      </Button>
    );
  } else if (n.kind === "task_failed") {
    actions = (
      <>
        <Button type="button" size="sm" variant="ghost" onClick={() => onOpen?.(n)}>
          {t("screens.inbox.open")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || n.taskId == null}
          onClick={() => onRetry?.(n)}
        >
          {t("common.retry")}
        </Button>
      </>
    );
  } else if (n.kind === "reminder" && n.actions.length > 0) {
    actions = n.actions.map((a, i) => (
      <Button
        key={a.id}
        type="button"
        size="sm"
        variant={a.destructive ? "destructive" : i === 0 ? "secondary" : "ghost"}
        disabled={busy}
        onClick={() => onAction?.(n, a.id)}
      >
        {a.label}
      </Button>
    ));
  } else if (n.route != null) {
    actions = (
      <Button type="button" size="sm" variant="ghost" onClick={() => onOpen?.(n)}>
        {t("screens.inbox.open")}
      </Button>
    );
  }

  return (
    <article
      aria-labelledby={titleId}
      data-unread={unread || undefined}
      className={cn(
        "flex flex-wrap items-start gap-3 border-b border-gray-6 py-3 pe-2 ps-0 text-sm",
        resolved || isStale ? "opacity-75" : "",
      )}
    >
      {/* Unread is the dot plus weight; the dot marks the row read (§3.20). */}
      <span className="flex h-7 w-5 shrink-0 items-center justify-center">
        {unread && onMarkRead ? (
          <button
            type="button"
            aria-label={t("screens.inbox.markReadLabel", { title: n.title })}
            title={t("screens.inbox.markRead")}
            onClick={() => onMarkRead(n)}
            className="group/dot flex size-5 items-center justify-center rounded-full hover:bg-gray-3 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="size-2 rounded-full bg-accent-9 transition-transform group-hover/dot:scale-125" />
          </button>
        ) : unread ? (
          <span className="size-2 rounded-full bg-accent-9" aria-hidden="true" />
        ) : null}
      </span>
      <span
        className={cn(
          "inline-flex size-7 shrink-0 items-center justify-center rounded-full",
          kind.tone,
        )}
        aria-hidden="true"
      >
        <Icon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex flex-wrap items-center gap-x-1.5 text-caption text-gray-11">
          <span className="font-medium">{kind.label}</span>
          <span aria-hidden="true">·</span>
          <span>{formatRelative(n.createdAt, now)}</span>
          {unread ? <span className="sr-only">{t("screens.inbox.unread")}</span> : null}
          {isStale ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-medium text-approval-text">
                {t("screens.inbox.stale", {
                  reason: n.staleReason ?? t("screens.inbox.staleRestart"),
                })}
              </span>
            </>
          ) : null}
        </p>
        <h2
          id={titleId}
          className={cn(
            "text-body",
            unread ? "font-semibold text-foreground" : "font-normal text-gray-12",
          )}
        >
          {n.title}
        </h2>
        {n.body ? <p className="text-small text-gray-11">{n.body}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 self-center">{actions}</div>
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
      <LoadingCards label={t("screens.inbox.loading")} count={4} lines={1} layout="rows" />
    ) : (
      <div aria-busy="true" className="min-h-24" />
    );
  } else if (error !== null) {
    body = (
      <ErrorState
        what={t("screens.inbox.loadFailed")}
        reason={error}
        did={t("screens.inbox.stillReach")}
        {...(onRetryLoad ? { retry: { onClick: onRetryLoad } } : {})}
      />
    );
  } else if (notifications.length === 0) {
    body = (
      <EmptyState
        icon={Inbox}
        {...(onOpenActivity
          ? { action: { label: t("screens.inbox.openActivity"), onClick: onOpenActivity } }
          : {})}
      >
        {t("screens.inbox.empty")}
      </EmptyState>
    );
  } else {
    body = (
      <ul aria-label={t("screens.inbox.notifications")} className="flex flex-col">
        {notifications.map((n) => (
          <li key={n.id}>
            {renderRow ? renderRow(n) : <InboxRow notification={n} now={now} {...rowProps} />}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section aria-label={t("screens.inbox.title")}>
      <Page width="wide">
        <PageHeader
          title={t("screens.inbox.title")}
          meta={
            !loading && error === null && unread > 0
              ? t("screens.inbox.unreadCount", { n: unread })
              : null
          }
          {...(unread > 0 && onMarkAllRead
            ? {
                actions: (
                  <Button type="button" size="sm" variant="ghost" onClick={onMarkAllRead}>
                    {t("screens.inbox.markAllRead")}
                  </Button>
                ),
              }
            : {})}
        />
        {body}
      </Page>
    </section>
  );
}

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
        toast.error(t("screens.inbox.failed", { what: failure, reason: describeError(err) }));
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
        run(() => ap.answer("approve", "once"), t("screens.inbox.sendApprovalFailed"));
      }}
      onDeny={() => {
        read();
        run(() => ap.answer("deny"), t("screens.inbox.sendDenialFailed"));
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
          t("screens.inbox.retryFailed", { title: x.title }),
        );
      }}
      onAction={(x, actionId) => run(() => resolve(x.id, actionId), t("screens.inbox.saveFailed"))}
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
            toast.error(t("screens.inbox.markFailed", { reason: describeError(err) }));
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
