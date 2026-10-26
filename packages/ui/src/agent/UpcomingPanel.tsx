import type { Automation, Lesson } from "@psyche/protocol";
import { CalendarClock, Ellipsis } from "lucide-react";
import type { ReactElement } from "react";
import { EmptyState } from "../components/page.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { useAutomations, useCall, useGatewayQuery, useThreads } from "../data/index.ts";
import { activeI18n, t } from "../i18n/core.ts";
import { formatRelative } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { useLessons } from "../teaching/hooks.ts";
import { LessonMark } from "../teaching/LessonMark.tsx";

const dateName = (d: Date, options: Intl.DateTimeFormatOptions) =>
  activeI18n().date(d, { ...options, timeZone: "UTC" });
/** A cron field's wall-clock hour and minute ("7:00 AM", "07:00"): built in UTC, shown in UTC. */
const clock = (d: Date) =>
  activeI18n().time(d, { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
const monthName = (month: number) =>
  dateName(new Date(Date.UTC(2026, month, 1)), { month: "short" });

/** "weekdays 07:00", "monthly on the 1st 09:00", "every 6 h" (UI design §3.16: the schedule as a sentence). */
export function scheduleSentence(a: Pick<Automation, "kind" | "schedule">): string {
  if (a.kind === "reminder") {
    const at = Date.parse(a.schedule);
    if (!Number.isNaN(at)) {
      // A reminder is an instant: shown on the owner's clock and calendar.
      const i18n = activeI18n();
      return t("agent.schedule.once", {
        weekday: i18n.date(at, { weekday: "short" }),
        month: i18n.date(at, { month: "short" }),
        day: Number(
          new Intl.DateTimeFormat("en-US", {
            day: "numeric",
            ...(i18n.timeZone ? { timeZone: i18n.timeZone } : {}),
          }).format(at),
        ),
        time: i18n.time(at, { hour: "numeric", minute: "2-digit" }),
      });
    }
  }
  const iso = /^P(?:T(?:(\d+)H)?(?:(\d+)M)?)$/.exec(a.schedule);
  if (iso) {
    const [, h, m] = iso;
    const span =
      h && m
        ? t("time.hMin", { h: Number(h), m: Number(m) })
        : h
          ? t("time.h", { h: Number(h) })
          : t("time.min", { n: Number(m ?? 0) });
    return t("agent.schedule.every", { span });
  }
  const parts = a.schedule.trim().split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, month, dow] = parts as [string, string, string, string, string];
    const time =
      /^\d+$/.test(min) && /^\d+$/.test(hour)
        ? clock(new Date(Date.UTC(2026, 0, 1, Number(hour), Number(min))))
        : null;
    if (time !== null) {
      if (/^\d+$/.test(dom) && /^\d+$/.test(month) && dow === "*") {
        return t("agent.schedule.date", {
          month: monthName((Number(month) - 1) % 12),
          day: Number(dom),
          time,
        });
      }
      if (dow === "1-5" && dom === "*") return t("agent.schedule.weekdays", { time });
      if (dow === "*" && dom === "*") return t("agent.schedule.daily", { time });
      if (dom !== "*" && dow === "*") return t("agent.schedule.monthly", { day: dom, time });
      if (/^\d$/.test(dow))
        return t("agent.schedule.weekly", { day: String(Number(dow) % 7), time });
    }
    if (min.startsWith("*/"))
      return t("agent.schedule.every", { span: t("time.min", { n: Number(min.slice(2)) }) });
  }
  return a.schedule;
}

/**
 * A one-shot: `kind: "reminder"` (an ISO instant), or a cron pinned to one date
 * ("0 17 22 10 *"), which is how chat's "remind me…" lands today.
 */
export function isReminder(a: Pick<Automation, "kind" | "schedule">): boolean {
  if (a.kind === "reminder") return true;
  const parts = a.schedule.trim().split(/\s+/);
  return (
    a.kind === "cron" &&
    parts.length === 5 &&
    /^\d+$/.test(parts[2] ?? "") &&
    /^\d+$/.test(parts[3] ?? "") &&
    parts[4] === "*"
  );
}

/** The reminder's schedule moved `ms` later (keeps the cron form for date-pinned crons). */
export function snoozedSchedule(
  a: Pick<Automation, "kind" | "schedule" | "nextRunAt">,
  ms: number,
  now: number,
): string {
  const base = Math.max(Date.parse(a.nextRunAt ?? a.schedule) || now, now);
  const at = new Date(base + ms);
  if (a.kind === "reminder") return at.toISOString();
  return `${at.getUTCMinutes()} ${at.getUTCHours()} ${at.getUTCDate()} ${at.getUTCMonth() + 1} *`;
}

function sessionLabel(a: Automation): string {
  if (a.sessionTarget.startsWith("named:"))
    return t("agent.upcoming.inNamed", { name: a.sessionTarget.slice(6) });
  return a.sessionTarget === "isolated"
    ? t("agent.upcoming.inOwnSession")
    : t("agent.upcoming.inMainSession");
}

const CHANNEL_NAME: Record<string, string> = {
  telegram: "Telegram",
  imessage: "iMessage",
  whatsapp: "WhatsApp",
  signal: "Signal",
  slack: "Slack",
  discord: "Discord",
  get email() {
    return t("agent.upcoming.email");
  },
};

/** "Delivers to Main and Telegram", "Delivers nothing unless something needs you" (§3.16). */
function useDeliverySentence(): (a: Automation) => string {
  const { all: threadList, main } = useThreads();
  const channels = useGatewayQuery("channels.list", {});
  return (a) => {
    const d = a.delivery;
    if (d.none === true) return t("agent.upcoming.quiet");
    const to: string[] = [];
    if (d.thread) {
      const thread =
        d.thread === main?.thread.id ? main : threadList.find((t) => t.thread.id === d.thread);
      to.push(
        thread?.thread.kind === "main"
          ? t("agent.upcoming.theMainChat")
          : (thread?.thread.title ?? t("agent.upcoming.aChat")),
      );
    }
    if (d.channel) {
      const type = channels.data?.channels.find((c) => c.id === d.channel)?.type;
      to.push(type ? (CHANNEL_NAME[type] ?? type) : t("agent.upcoming.aChannel"));
    }
    if (d.webhook) to.push("a webhook");
    return to.length === 0
      ? t("agent.upcoming.nowhere")
      : t("agent.upcoming.deliversTo", { to: activeI18n().list(to) });
  };
}

function lastOutcome(a: Automation): ReactElement | null {
  if (!a.lastStatus) return null;
  const s = a.lastStatus.toLowerCase();
  const variant = /^(failed|error)/.test(s)
    ? "danger"
    : /^(delivered|done|ok)/.test(s)
      ? "success"
      : "muted";
  return <Badge variant={variant}>{t("agent.upcoming.last", { status: a.lastStatus })}</Badge>;
}

export function UpcomingRow({
  automation: a,
  now,
  delivery,
  onRun,
  onToggle,
  onDelete,
  onEdit,
  onSnooze,
  onDone,
  lesson,
}: {
  automation: Automation;
  /** The lesson that last changed one of its parameters (teaching loop §5.2). */
  lesson?: Lesson | null;
  now: number;
  /** The delivery target as a sentence. */
  delivery?: string;
  onRun?: () => void;
  onToggle?: () => void;
  onDelete?: () => void;
  onEdit?: () => void;
  /** Reminders (§3.16): Snooze and Done instead of Run now. */
  onSnooze?: () => void;
  onDone?: () => void;
}): ReactElement {
  const reminder = isReminder(a) && (onSnooze !== undefined || onDone !== undefined);
  const nextAt = a.nextRunAt ?? null;
  const next =
    nextAt === null
      ? null
      : Date.parse(nextAt) >= now
        ? t("agent.upcoming.nextRun", { when: formatRelative(nextAt, now) })
        : t("agent.upcoming.dueNow");
  return (
    <li className="flex items-start gap-3 py-3">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-body font-medium">{a.title}</span>
          {a.kind === "watch" ? <Badge variant="info">{t("agent.upcoming.watch")}</Badge> : null}
          {!a.enabled ? <Badge variant="muted">{t("agent.upcoming.paused")}</Badge> : null}
        </span>
        <span className="mt-0.5 block text-callout text-label-secondary">
          {t("agent.upcoming.runs", {
            once: reminder,
            schedule: scheduleSentence(a),
            session: sessionLabel(a),
            next: next && a.enabled ? next : "",
            hasNext: Boolean(next && a.enabled),
          })}
        </span>
        {delivery ? (
          <span className="block text-callout text-label-secondary">{delivery}</span>
        ) : null}
        {a.kind === "watch" && a.scratch ? (
          <span className="block text-callout text-label-secondary">{a.scratch}</span>
        ) : null}
        {a.lastStatus ? <span className="mt-1 flex">{lastOutcome(a)}</span> : null}
        {lesson ? <LessonMark lesson={lesson} variant="automation" className="mt-1" /> : null}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {reminder ? (
          <>
            {onSnooze ? (
              <Button size="sm" variant="ghost" onClick={onSnooze}>
                {t("agent.upcoming.snooze")}
              </Button>
            ) : null}
            {onDone ? (
              <Button size="sm" variant="outline" onClick={onDone}>
                {t("common.done")}
              </Button>
            ) : null}
          </>
        ) : onRun ? (
          <Button size="sm" variant="ghost" onClick={onRun}>
            {t("agent.upcoming.runNow")}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("agent.upcoming.moreFor", { title: a.title })}
              />
            }
          >
            <Ellipsis aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {reminder && onRun ? (
              <DropdownMenuItem onClick={onRun}>{t("agent.upcoming.runNow")}</DropdownMenuItem>
            ) : null}
            {onToggle ? (
              <DropdownMenuItem onClick={onToggle}>
                {a.enabled ? t("agent.task.pause") : t("agent.activity.resume")}
              </DropdownMenuItem>
            ) : null}
            {onEdit ? (
              <DropdownMenuItem onClick={onEdit}>{t("common.edit")}</DropdownMenuItem>
            ) : null}
            {onDelete ? (
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                {t("common.delete")}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </li>
  );
}

const SNOOZE_MS = 60 * 60 * 1000;

/** Agent sheet → Upcoming (UI design §3.16): reminders, scheduled tasks, watches, heartbeat. */
export function UpcomingPanel({
  now: fixedNow,
  onEdit,
}: {
  now?: number;
  onEdit?: (automation: Automation) => void;
}): ReactElement {
  const now = useNow(30_000, fixedNow);
  const q = useAutomations();
  const lessons = useLessons({ destination: "automation" }).lessons;
  const call = useCall();
  const deliverySentence = useDeliverySentence();
  if (q.loading && q.automations.length === 0) {
    return (
      <div className="flex flex-col gap-2" role="status" aria-label={t("agent.upcoming.loading")}>
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  }
  if (q.error && q.automations.length === 0) {
    return (
      <p className="px-2 text-body">
        {t("agent.upcoming.loadFailed", { reason: q.error })}{" "}
        <button type="button" className="text-accent-11 underline" onClick={q.reload}>
          {t("agent.activity.tryAgain")}
        </button>
      </p>
    );
  }
  if (q.automations.length === 0) {
    return <EmptyState icon={CalendarClock}>{t("agent.upcoming.empty")}</EmptyState>;
  }
  const sorted = [...q.automations].sort((a, b) =>
    (a.nextRunAt ?? "9999").localeCompare(b.nextRunAt ?? "9999"),
  );
  return (
    <ul
      className="flex flex-col divide-y divide-separator px-2"
      aria-label={t("agent.sheet.upcoming")}
    >
      {sorted.map((a) => (
        <UpcomingRow
          key={a.id}
          automation={a}
          now={now}
          delivery={deliverySentence(a)}
          lesson={
            lessons.find(
              (l) => l.destination.type === "automation" && l.destination.automationId === a.id,
            ) ?? null
          }
          onRun={() => void q.runNow(a.id)}
          onToggle={() => void q.setEnabled(a.id, !a.enabled)}
          onDelete={() => void q.remove(a.id)}
          {...(isReminder(a)
            ? {
                onSnooze: async () => {
                  await call("automations.update", {
                    automationId: a.id,
                    schedule: snoozedSchedule(a, SNOOZE_MS, now),
                  });
                  q.reload();
                },
                onDone: () => void q.remove(a.id),
              }
            : {})}
          {...(onEdit ? { onEdit: () => onEdit(a) } : {})}
        />
      ))}
    </ul>
  );
}
