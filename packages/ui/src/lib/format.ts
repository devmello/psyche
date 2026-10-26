import { activeI18n, t } from "../i18n/core.ts";

/**
 * Small formatting helpers shared by blocks and screens (UI design §4.12 copy voice). Words come
 * from the catalogue (`time.*`) and numbers and dates follow the active format locale (A12).
 */

/** A clock time in the active format locale ("14:05"; 24-hour, UTC as before #608). */
export function formatTime(iso: string): string {
  return activeI18n().time(iso, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
}

/** A short date in the active format locale ("Oct 2", "2 Oct", "2. Okt."). */
export function formatDate(iso: string): string {
  return activeI18n().date(iso, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "12 s", "3 min", "1 h 5 min". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return t("time.ms", { n: Math.max(0, Math.round(ms)) });
  const s = Math.round(ms / 1000);
  if (s < 60) return t("time.s", { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("time.min", { n: m });
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? t("time.h", { h }) : t("time.hMin", { h, m: m % 60 });
}

/** Countdown "28:41", or "0:45" under a minute. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/**
 * "just now", "41 min ago", "3 h ago", "yesterday", "4 days ago", then a date ("Oct 2"); the
 * future reads "in 41 min", "in 3 h", "tomorrow", "in 4 days", "on Oct 30". Hours drop their
 * minutes from 2 h on, so a list never shows "409 h 7 min ago".
 */
export function formatRelative(iso: string, now: number): string {
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return t("time.justNow");
  const past = diff < 0;
  const hour = 3_600_000;
  const day = 24 * hour;
  let label: string;
  if (abs < 2 * hour) label = formatDuration(abs);
  else if (abs < day) label = t("time.h", { h: Math.round(abs / hour) });
  else {
    const days = Math.round(abs / day);
    if (days === 1) return past ? t("time.yesterday") : t("time.tomorrow");
    if (days < 7) label = t("time.days", { n: days });
    else return past ? formatDate(iso) : t("time.onDate", { date: formatDate(iso) });
  }
  return past ? t("time.ago", { label }) : t("time.in", { label });
}

/**
 * English-only "3 items" for strings not yet in the catalogue. New code uses an ICU plural in a
 * catalogue message instead (`{n, plural, one {# item} other {# items}}`).
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The tool family shown in folded runs: `browser.navigate` → `browser`, `mcp__notion__x` → `notion`. */
export function toolFamily(tool: string): string {
  if (tool.startsWith("mcp__")) return tool.split("__")[1] ?? "mcp";
  return tool.split(/[._]/)[0] ?? tool;
}
