import type { Automation } from "@psyche/protocol";
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
import { formatRelative } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "weekdays 07:00", "monthly on the 1st 09:00", "every 6 h" (UI design §3.16: the schedule as a sentence). */
export function scheduleSentence(a: Pick<Automation, "kind" | "schedule">): string {
  if (a.kind === "reminder") {
    const at = Date.parse(a.schedule);
    if (!Number.isNaN(at)) {
      const d = new Date(at);
      const time = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
      return `${DAYS[d.getUTCDay()]?.slice(0, 3)} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${time}`;
    }
  }
  const iso = /^P(?:T(?:(\d+)H)?(?:(\d+)M)?)$/.exec(a.schedule);
  if (iso) {
    const [, h, m] = iso;
    return `every ${h ? `${h} h` : ""}${h && m ? " " : ""}${m ? `${m} min` : ""}`;
  }
  const parts = a.schedule.trim().split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, month, dow] = parts as [string, string, string, string, string];
    const time =
      /^\d+$/.test(min) && /^\d+$/.test(hour)
        ? `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`
        : null;
    if (time !== null) {
      if (/^\d+$/.test(dom) && /^\d+$/.test(month) && dow === "*") {
        return `${MONTHS[(Number(month) - 1) % 12]} ${Number(dom)} ${time}`;
      }
      if (dow === "1-5" && dom === "*") return `weekdays ${time}`;
      if (dow === "*" && dom === "*") return `every day ${time}`;
      if (dom !== "*" && dow === "*") return `monthly on day ${dom} ${time}`;
      if (/^\d$/.test(dow)) return `${DAYS[Number(dow) % 7]}s ${time}`;
    }
    if (min.startsWith("*/")) return `every ${min.slice(2)} min`;
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
  if (a.sessionTarget.startsWith("named:")) return `in ${a.sessionTarget.slice(6)}`;
  return a.sessionTarget === "isolated" ? "in its own session" : "in the main session";
}

const CHANNEL_NAME: Record<string, string> = {
  telegram: "Telegram",
  imessage: "iMessage",
  whatsapp: "WhatsApp",
  signal: "Signal",
  slack: "Slack",
  discord: "Discord",
  email: "email",
};

/** "Delivers to Main and Telegram", "Delivers nothing unless something needs you" (§3.16). */
function useDeliverySentence(): (a: Automation) => string {
  const { all: threadList, main } = useThreads();
  const channels = useGatewayQuery("channels.list", {});
  return (a) => {
    const d = a.delivery;
    if (d.none === true) return "Stays quiet unless something needs you";
    const to: string[] = [];
    if (d.thread) {
      const thread =
        d.thread === main?.thread.id ? main : threadList.find((t) => t.thread.id === d.thread);
      to.push(
        thread?.thread.kind === "main" ? "the main chat" : (thread?.thread.title ?? "a chat"),
      );
    }
    if (d.channel) {
      const type = channels.data?.channels.find((c) => c.id === d.channel)?.type;
      to.push(type ? (CHANNEL_NAME[type] ?? type) : "a channel");
    }
    if (d.webhook) to.push("a webhook");
    return to.length === 0 ? "Delivers nowhere yet" : `Delivers to ${to.join(" and ")}`;
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
  return <Badge variant={variant}>last: {a.lastStatus}</Badge>;
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
}: {
  automation: Automation;
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
        ? `next run ${formatRelative(nextAt, now)}`
        : "due now";
  return (
    <li className="flex items-start gap-3 py-3">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-small font-medium">{a.title}</span>
          {a.kind === "watch" ? <Badge variant="info">watch</Badge> : null}
          {!a.enabled ? <Badge variant="muted">paused</Badge> : null}
        </span>
        <span className="mt-0.5 block text-caption text-gray-11">
          {reminder ? "Once, " : "Runs "}
          {scheduleSentence(a)} {sessionLabel(a)}
          {next && a.enabled ? ` · ${next}` : ""}
        </span>
        {delivery ? (
          <span className="block text-caption text-muted-foreground">{delivery}</span>
        ) : null}
        {a.kind === "watch" && a.scratch ? (
          <span className="block text-caption text-muted-foreground">{a.scratch}</span>
        ) : null}
        {a.lastStatus ? <span className="mt-1 flex">{lastOutcome(a)}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {reminder ? (
          <>
            {onSnooze ? (
              <Button size="sm" variant="ghost" onClick={onSnooze}>
                Snooze
              </Button>
            ) : null}
            {onDone ? (
              <Button size="sm" variant="outline" onClick={onDone}>
                Done
              </Button>
            ) : null}
          </>
        ) : onRun ? (
          <Button size="sm" variant="ghost" onClick={onRun}>
            Run now
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="icon-sm" variant="ghost" aria-label={`More for ${a.title}`} />}
          >
            <Ellipsis aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {reminder && onRun ? (
              <DropdownMenuItem onClick={onRun}>Run now</DropdownMenuItem>
            ) : null}
            {onToggle ? (
              <DropdownMenuItem onClick={onToggle}>
                {a.enabled ? "Pause" : "Resume"}
              </DropdownMenuItem>
            ) : null}
            {onEdit ? <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem> : null}
            {onDelete ? (
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                Delete
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
  const call = useCall();
  const deliverySentence = useDeliverySentence();
  if (q.loading && q.automations.length === 0) {
    return (
      <div className="flex flex-col gap-2" role="status" aria-label="Loading upcoming">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  }
  if (q.error && q.automations.length === 0) {
    return (
      <p className="px-2 text-small">
        Psyche couldn't load your schedule ({q.error}).{" "}
        <button type="button" className="text-accent-11 underline" onClick={q.reload}>
          Try again
        </button>
      </p>
    );
  }
  if (q.automations.length === 0) {
    return (
      <EmptyState icon={CalendarClock}>Nothing scheduled. Ask in chat with /schedule.</EmptyState>
    );
  }
  const sorted = [...q.automations].sort((a, b) =>
    (a.nextRunAt ?? "9999").localeCompare(b.nextRunAt ?? "9999"),
  );
  return (
    <ul className="flex flex-col divide-y divide-gray-4 px-2" aria-label="Upcoming">
      {sorted.map((a) => (
        <UpcomingRow
          key={a.id}
          automation={a}
          now={now}
          delivery={deliverySentence(a)}
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
