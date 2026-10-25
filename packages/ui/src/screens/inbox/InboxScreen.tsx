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
import { EmptyState, ErrorState, LoadingCards, useDelayedFlag } from "../../components/page.tsx";
import { StatusGlyph, type StatusKind } from "../../components/status.tsx";
import { Button } from "../../components/ui/button.tsx";
import { useApproval, useNotifications, useTask } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { formatCountdown, formatRelative } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { cn } from "../../lib/utils.ts";
import { ListItem } from "../../motion/index.ts";
import { useSlots } from "../../slots.tsx";
import { ScreenColumn, ScreenToolbar } from "../feed/ScreenToolbar.tsx";

/** Semantic tones only (§4.8): approval, success, danger, info, or neutral gray. */
const TONE = {
  approval: "bg-amber-3 text-approval-text",
  success: "bg-grass-3 text-grass-11",
  danger: "bg-tomato-3 text-tomato-12 dark:text-tomato-11",
  info: "bg-sky-3 text-sky-11",
  muted: "bg-fill-tertiary text-label-secondary",
} as const;

export const NOTIFICATION_KIND: Record<
  NotificationKind,
  { label: string; icon: LucideIcon; tone: string; status?: StatusKind }
> = {
  approval: {
    get label() {
      return t("screens.inbox.kind.approval");
    },
    icon: CircleAlert,
    tone: TONE.approval,
    status: "waiting",
  },
  input_needed: {
    get label() {
      return t("screens.inbox.kind.input_needed");
    },
    icon: CircleHelp,
    tone: TONE.approval,
    status: "waiting",
  },
  task_done: {
    get label() {
      return t("screens.inbox.kind.task_done");
    },
    icon: CircleCheck,
    tone: TONE.success,
    status: "done",
  },
  task_failed: {
    get label() {
      return t("screens.inbox.kind.task_failed");
    },
    icon: CircleX,
    tone: TONE.danger,
    status: "failed",
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
    return (
      <span className="text-callout text-label-secondary">{DECIDED[a.status] ?? a.status}</span>
    );
  }
  const remaining = Date.parse(a.expiresAt) - now;
  if (remaining <= 0) {
    return (
      <span className="text-callout text-label-secondary">
        {t("screens.inbox.decided.expired")}
      </span>
    );
  }
  const countdown = (
    <span
      className={cn(
        "me-1 text-callout tabular-nums",
        remaining < 60_000 ? "font-semibold text-danger-text" : "text-label-secondary",
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
    actions = (
      <span className="text-callout text-label-secondary">{t("screens.inbox.resolved")}</span>
    );
  } else if (n.kind === "input_needed") {
    actions = (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onOpen?.(n)}
        disabled={n.route == null}
      >
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
          variant="outline"
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
        variant={a.destructive ? "destructive" : i === 0 ? "outline" : "ghost"}
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
        // A two-line grouped row (redesign §3.7): status glyph, kind · time, title, body, actions.
        "relative flex min-h-11 flex-wrap items-start gap-3 px-3 py-2 text-body",
        "before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator",
        resolved || isStale ? "opacity-75" : "",
      )}
    >
      {/* Unread is the dot plus weight; the dot marks the row read (§3.20). */}
      <span className="-ms-1 flex h-5 w-3 shrink-0 items-center justify-center">
        {unread && onMarkRead ? (
          <button
            type="button"
            aria-label={t("screens.inbox.markReadLabel", { title: n.title })}
            title={t("screens.inbox.markRead")}
            onClick={() => onMarkRead(n)}
            className="group/dot flex size-5 items-center justify-center rounded-full hover:bg-fill-quaternary focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="size-2 rounded-full bg-accent-9" />
          </button>
        ) : unread ? (
          <span className="size-2 rounded-full bg-accent-9" aria-hidden="true" />
        ) : null}
      </span>
      {/* One glyph per state (§3.6): status kinds use the shared glyph, the rest their icon. */}
      <span className="flex h-5 shrink-0 items-center" aria-hidden="true">
        {kind.status ? (
          <StatusGlyph status={resolved ? "done" : kind.status} />
        ) : (
          <Icon className="size-4 text-label-secondary" />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h3
          id={titleId}
          className={cn(
            "text-headline text-label-primary",
            unread ? "font-semibold" : "font-normal",
          )}
        >
          {n.title}
        </h3>
        {n.body ? <p className="text-callout text-label-secondary">{n.body}</p> : null}
        <p className="flex flex-wrap items-center gap-x-1.5 text-subheadline text-label-tertiary">
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
      </div>
      <div className="flex flex-wrap items-center gap-1.5 self-center">{actions}</div>
    </article>
  );
}

/** Rows group by what they ask (§5.10, grouped rows): what needs you, then today, then earlier. */
function groupOf(n: Notification, now: number): "needs" | "today" | "earlier" {
  if ((n.kind === "approval" || n.kind === "input_needed") && n.resolvedAt == null) return "needs";
  return now - Date.parse(n.createdAt) < 24 * 60 * 60 * 1000 ? "today" : "earlier";
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
    const groups = (["needs", "today", "earlier"] as const)
      .map((g) => ({ id: g, items: notifications.filter((n) => groupOf(n, now) === g) }))
      .filter((g) => g.items.length > 0);
    body = (
      <fieldset
        aria-label={t("screens.inbox.notifications")}
        className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0"
      >
        {groups.map((g) => (
          <section key={g.id} aria-labelledby={`inbox-${g.id}`} className="flex flex-col gap-2">
            <h2 id={`inbox-${g.id}`} className="px-1 text-title-3 text-label-primary">
              {t(`screens.inbox.group.${g.id}`)}
            </h2>
            <ul className="flex flex-col rounded-lg bg-surface-raised shadow-elevation-1 [&>li:first-child>article]:before:hidden">
              {g.items.map((n, i) => (
                <ListItem key={n.id} index={i}>
                  {renderRow ? renderRow(n) : <InboxRow notification={n} now={now} {...rowProps} />}
                </ListItem>
              ))}
            </ul>
          </section>
        ))}
      </fieldset>
    );
  }

  return (
    <section aria-label={t("screens.inbox.title")}>
      <ScreenToolbar
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
      <ScreenColumn width="wide">{body}</ScreenColumn>
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
