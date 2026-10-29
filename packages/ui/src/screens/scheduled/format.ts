import type { ScheduledItem } from "@psyche/protocol";
import { scheduleSentence } from "../../agent/UpcomingPanel.tsx";
import { activeI18n, isMessageId, t } from "../../i18n/core.ts";
import { tk } from "../../i18n/dynamic.ts";
import { formatRelative } from "../../lib/format.ts";

/** Routines whose catalogue name is better than the stored (English) title. */
const NAMED = new Set([
  "daily-brief",
  "daily-wrapup",
  "mail-digest",
  "mail-voice",
  "mail-watch",
  "mail-focus",
  "notes-folder",
  "feed-brief",
  "ideas-mine",
  "ideas-deliver",
  "memory-dreaming",
  "weekly-card",
  "heartbeat",
]);

/** "daily-brief" → "dailyBrief": catalogue ids are camelCase. */
const idPart = (routine: string) => routine.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** "Morning brief"; the owner's own automations and per-item routines keep their title. */
export function itemName(item: Pick<ScheduledItem, "routine" | "title">): string {
  if (item.routine !== undefined && NAMED.has(item.routine)) {
    return tk(`scheduled.routine.${idPart(item.routine)}.name`);
  }
  return item.title;
}

/** What it does, in one line. */
export function itemDoes(item: Pick<ScheduledItem, "routine" | "summary">): string {
  if (item.routine === undefined) {
    return item.summary === "" ? t("scheduled.row.noSummary") : item.summary;
  }
  const id = `scheduled.routine.${idPart(item.routine)}.does`;
  return isMessageId(id) ? t(id) : t("scheduled.routine.generic");
}

/** "Weekdays at 9:00" for the item's schedule, first letter up. */
export function itemSchedule(item: Pick<ScheduledItem, "kind" | "schedule">): string {
  const s = scheduleSentence(item);
  return s.charAt(0).toLocaleUpperCase(activeI18n().locale) + s.slice(1);
}

/** "Thu, Oct 29 at 9:00 AM" on the owner's clock. */
export function absoluteWhen(iso: string, timezone: string): string {
  const i18n = activeI18n();
  return t("scheduled.row.absolute", {
    date: i18n.date(iso, { weekday: "short", month: "short", day: "numeric", timeZone: timezone }),
    time: i18n.time(iso, { hour: "numeric", minute: "2-digit", timeZone: timezone }),
  });
}

/** "in 2 h · Thu, Oct 29 at 9:00 AM", or why there is no next run. */
export function nextRunLine(item: ScheduledItem, now: number, timezone: string): string {
  if (item.state === "paused") return t("scheduled.row.nextPaused");
  if (item.state === "off") return t("scheduled.row.nextOff");
  if (item.nextRunAt == null) {
    return item.kind === "event" ? t("scheduled.row.nextEvent") : t("scheduled.row.nextNone");
  }
  return t("scheduled.row.nextAt", {
    relative: formatRelative(item.nextRunAt, now),
    absolute: absoluteWhen(item.nextRunAt, timezone),
  });
}

export function statusLabel(status: string): string {
  const id = `scheduled.status.${status}`;
  return isMessageId(id) ? t(id) : status;
}

/** "Done · 3 h ago", or "Hasn't run yet". */
export function lastRunLine(item: ScheduledItem, now: number): string {
  if (item.lastRunAt == null) return t("scheduled.row.never");
  return t("scheduled.row.lastAt", {
    status: item.lastStatus == null ? "" : statusLabel(item.lastStatus),
    relative: formatRelative(item.lastRunAt, now),
  });
}

/** The approvals line: each id's sentence, or "None". */
export function approvalLines(approvals: readonly string[]): string[] {
  if (approvals.length === 0) return [t("scheduled.approvals.none")];
  return approvals.map((a) => {
    const id = `scheduled.approvals.${a}`;
    return isMessageId(id) ? t(id) : a;
  });
}
