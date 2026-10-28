/**
 * Settings → Daily. Plain settings keys, read with `settings.get` and written with
 * `settings.set` (the onboarding "Turn on habits" step writes `daily.brief.enabled` and
 * `daily.wrapup.enabled`). Every read goes to the store, so a change applies on the next run;
 * the two jobs' schedules follow `DailyService.syncSchedules()`.
 */

export const DAILY_SETTING_KEYS = [
  "daily.brief.enabled",
  "daily.brief.time",
  "daily.wrapup.enabled",
  "daily.wrapup.time",
  "daily.notify",
  "daily.messages",
  "daily.followups.enabled",
  "daily.followups.sensitivity",
] as const;
export type DailySettingKey = (typeof DAILY_SETTING_KEYS)[number];

export const FOLLOWUPS_KEY = "daily.followups.items";

export type FollowupSensitivity = "low" | "normal" | "high";

export interface DailySettings {
  brief: { enabled: boolean; time: string };
  wrapup: { enabled: boolean; time: string };
  /** Send a notification with the card (held through quiet hours). Default on. */
  notify: boolean;
  /** Also deliver the brief over the Messages channel. Default off. */
  messages: boolean;
  followups: { enabled: boolean; sensitivity: FollowupSensitivity; awaitingDays: number };
}

export interface KeyValue {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export const DEFAULT_BRIEF_TIME = "08:00";
export const DEFAULT_WRAPUP_TIME = "18:00";
const AWAITING_DAYS: Record<FollowupSensitivity, number> = { low: 5, normal: 3, high: 2 };

export function validTime(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return m === null ? fallback : `${m[1]?.padStart(2, "0")}:${m[2]}`;
}

export function readDailySettings(kv: Pick<KeyValue, "get">): DailySettings {
  const sens = kv.get("daily.followups.sensitivity");
  const sensitivity: FollowupSensitivity =
    sens === "low" || sens === "high" || sens === "normal" ? sens : "normal";
  return {
    brief: {
      enabled: kv.get("daily.brief.enabled") === true,
      time: validTime(kv.get("daily.brief.time"), DEFAULT_BRIEF_TIME),
    },
    wrapup: {
      enabled: kv.get("daily.wrapup.enabled") === true,
      time: validTime(kv.get("daily.wrapup.time"), DEFAULT_WRAPUP_TIME),
    },
    notify: kv.get("daily.notify") !== false,
    messages: kv.get("daily.messages") === true,
    followups: {
      enabled: kv.get("daily.followups.enabled") !== false,
      sensitivity,
      awaitingDays: AWAITING_DAYS[sensitivity],
    },
  };
}

/** `HH:MM` as a daily cron expression. */
export function dailyCron(time: string): string {
  const [h = "8", m = "0"] = time.split(":");
  return `${Number(m)} ${Number(h)} * * *`;
}
