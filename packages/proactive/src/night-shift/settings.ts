/**
 * Night shift settings (docs/design/night-shift-2026.md §8): flat `nightShift.*` keys, read from the
 * store at every use so a change applies on the next tick. Night shift is off until the owner turns
 * it on; once on, all four domains are on by default. Not a security setting: enabling it grants
 * nothing, because apply still asks.
 */

export const NIGHT_SHIFT_MARKER = "[psyche:night-shift start]";
export const NIGHT_SHIFT_JOB = "night-shift";

export const NIGHT_DOMAINS = ["mail", "calendar", "reminders", "files"] as const;
export type NightDomain = (typeof NIGHT_DOMAINS)[number];

export const NIGHT_SHIFT_SETTING_KEYS = [
  "nightShift.enabled",
  "nightShift.consentedAt",
  "nightShift.window.start",
  "nightShift.window.end",
  "nightShift.domains.mail",
  "nightShift.domains.calendar",
  "nightShift.domains.reminders",
  "nightShift.domains.files",
  "nightShift.budgetUsd",
  "nightShift.expiryDays",
  "nightShift.notify",
] as const;

export const DEFAULT_WINDOW_START = "01:00";
export const DEFAULT_WINDOW_END = "05:00";
export const DEFAULT_BUDGET_USD = 0.5;
export const MIN_BUDGET_USD = 0.05;
export const MAX_BUDGET_USD = 5;
/** A night's token ceiling: it binds local or unpriced models, which cost nothing in dollars. */
export const NIGHT_TOKEN_CEILING = 400_000;
export const DEFAULT_EXPIRY_DAYS = 3;

export interface NightShiftSettings {
  enabled: boolean;
  window: { start: string; end: string };
  domains: Record<NightDomain, boolean>;
  budgetUsd: number;
  expiryDays: number;
  notify: boolean;
}

export interface KeyReader {
  get(key: string): unknown;
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function clock(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const m = HHMM.exec(value.trim());
  return m === null ? fallback : `${(m[1] as string).padStart(2, "0")}:${m[2]}`;
}

export const minutesOf = (hhmm: string): number => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
};

function clamp(value: unknown, lo: number, hi: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(hi, Math.max(lo, value))
    : fallback;
}

export function readNightShiftSettings(kv: KeyReader): NightShiftSettings {
  let start = clock(kv.get("nightShift.window.start"), DEFAULT_WINDOW_START);
  let end = clock(kv.get("nightShift.window.end"), DEFAULT_WINDOW_END);
  // The window must leave at least an hour (end may be past midnight of the start's day).
  const length = (minutesOf(end) - minutesOf(start) + 1440) % 1440;
  if (length < 60) {
    start = DEFAULT_WINDOW_START;
    end = DEFAULT_WINDOW_END;
  }
  const domain = (d: NightDomain) => kv.get(`nightShift.domains.${d}`) !== false;
  return {
    enabled: kv.get("nightShift.enabled") === true,
    window: { start, end },
    domains: {
      mail: domain("mail"),
      calendar: domain("calendar"),
      reminders: domain("reminders"),
      files: domain("files"),
    },
    budgetUsd: clamp(
      kv.get("nightShift.budgetUsd"),
      MIN_BUDGET_USD,
      MAX_BUDGET_USD,
      DEFAULT_BUDGET_USD,
    ),
    expiryDays: Math.round(clamp(kv.get("nightShift.expiryDays"), 1, 7, DEFAULT_EXPIRY_DAYS)),
    notify: kv.get("nightShift.notify") !== false,
  };
}

export const enabledDomains = (s: NightShiftSettings): Set<NightDomain> =>
  new Set(NIGHT_DOMAINS.filter((d) => s.domains[d]));
