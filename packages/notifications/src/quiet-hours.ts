import {
  NOTIFICATION_SETTING_DEFAULTS,
  type NotificationKind,
  type NotificationSettingKey,
  PsycheError,
} from "@psyche/protocol";

const MINUTE = 60_000;
const DAY_MINUTES = 24 * 60;

/**
 * Quiet hours (O10). Inside the window, interruptive deliveries (OS, channels) are deferred to
 * the window's end; the in-app inbox row is still written at once. `start` may be later than
 * `end` (the window crosses midnight); `start === end` means
 * 24 hours from `start`.
 */
export interface QuietHoursConfig {
  /** Local `HH:MM`, inclusive. */
  start: string;
  /** Local `HH:MM`, exclusive. */
  end: string;
  /** IANA zone, e.g. `America/Los_Angeles`. */
  timezone: string;
  /** Local weekdays (0 = Sunday) on which a window *starts*; default every day. */
  days?: number[];
  /** Kinds delivered immediately even inside the window. Default `["approval"]`. */
  breakthrough?: NotificationKind[];
}

export const DEFAULT_BREAKTHROUGH: readonly NotificationKind[] = ["approval"];

function parseHm(text: string, field: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  const h = m === null ? Number.NaN : Number(m[1]);
  const mi = m === null ? Number.NaN : Number(m[2]);
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) {
    throw new PsycheError("invalid_params", `quiet hours ${field} must be HH:MM, got ${text}`);
  }
  return h * 60 + mi;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(ms: number, timezone: string): { minutes: number; weekday: number } {
  let f = formatters.get(timezone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
        weekday: "short",
      });
    } catch (cause) {
      throw new PsycheError("invalid_params", `unknown timezone ${timezone}`, { cause });
    }
    formatters.set(timezone, f);
  }
  const parts = f.formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { minutes: Number(get("hour")) * 60 + Number(get("minute")), weekday };
}

/** Validates a config eagerly so a bad setting fails at load, not at 3 a.m. */
export function validateQuietHours(cfg: QuietHoursConfig): void {
  parseHm(cfg.start, "start");
  parseHm(cfg.end, "end");
  localParts(0, cfg.timezone);
  for (const d of cfg.days ?? []) {
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      throw new PsycheError("invalid_params", `quiet hours day must be 0–6, got ${d}`);
    }
  }
}

export function isQuietAt(cfg: QuietHoursConfig, ms: number): boolean {
  const start = parseHm(cfg.start, "start");
  const end = parseHm(cfg.end, "end");
  const { minutes, weekday } = localParts(ms, cfg.timezone);
  const days = cfg.days;
  const startsOn = (d: number) => days === undefined || days.includes(d);
  if (start < end) return minutes >= start && minutes < end && startsOn(weekday);
  // Crosses midnight (or `start === end`: 24 h from `start`): the part after `start` belongs to
  // today's window, the part before `end` to yesterday's.
  if (minutes >= start) return startsOn(weekday);
  if (minutes < end) return startsOn((weekday + 6) % 7);
  return false;
}

/**
 * The first minute at or after `ms` that is outside quiet hours (`ms` itself when not quiet).
 * A window can only end at the local `end` time, so this tries each day's local `end` in turn;
 * the minute walks absorb DST shifts (a skipped or repeated local hour). A window that covers
 * every day never ends: returns `undefined`.
 */
export function quietEndsAt(cfg: QuietHoursConfig, ms: number): number | undefined {
  if (!isQuietAt(cfg, ms)) return ms;
  const end = parseHm(cfg.end, "end");
  const minutesAt = (t: number) => localParts(t, cfg.timezone).minutes;
  const delta = (end - minutesAt(ms) + DAY_MINUTES) % DAY_MINUTES || DAY_MINUTES;
  let t = Math.floor(ms / MINUTE) * MINUTE + delta * MINUTE;
  for (let day = 0; day < 8; day += 1) {
    // After a fall-back the wall clock lags by up to an hour: walk forward to the local `end`.
    for (let i = 0, a = t; i <= 90; i += 1, a += MINUTE) {
      if (minutesAt(a) === end) {
        t = a;
        break;
      }
    }
    if (!isQuietAt(cfg, t)) {
      // After a spring-forward `t` may overshoot: step back to the first non-quiet minute.
      while (t - MINUTE > ms && !isQuietAt(cfg, t - MINUTE)) t -= MINUTE;
      return t;
    }
    t += DAY_MINUTES * MINUTE;
  }
  return undefined;
}

export function breaksThrough(cfg: QuietHoursConfig, kind: NotificationKind): boolean {
  return (cfg.breakthrough ?? DEFAULT_BREAKTHROUGH).includes(kind);
}

const HM = /^([01]?\d|2[0-3]):[0-5]\d$/;

/**
 * The owner's quiet hours (Settings → Notifications) as a `QuietHoursConfig`, or `null` while
 * they are off (the default). `read` returns a setting's stored value (`undefined` when unset);
 * a time that is not a valid `HH:MM` falls back to the default so a bad value never takes the
 * window down. The zone is the caller's (the system zone); `breakthrough` keeps its default.
 */
export function quietHoursFromSettings(
  read: (key: NotificationSettingKey) => unknown,
  timezone: string,
): QuietHoursConfig | null {
  if (read("notifications.quietHours.enabled") !== true) return null;
  const time = (key: "notifications.quietHours.start" | "notifications.quietHours.end") => {
    const v = read(key);
    return typeof v === "string" && HM.test(v.trim())
      ? v.trim().padStart(5, "0")
      : NOTIFICATION_SETTING_DEFAULTS[key];
  };
  return {
    start: time("notifications.quietHours.start"),
    end: time("notifications.quietHours.end"),
    timezone,
  };
}
