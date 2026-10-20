/** Small formatting helpers shared by blocks and screens (UI design §4.12 copy voice). */

export function formatTime(iso: string, locale?: string): string {
  return new Date(iso).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
}

export function formatDate(iso: string, locale?: string): string {
  return new Date(iso).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "12 s", "3 min", "1 h 5 min". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
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
  if (abs < 45_000) return "just now";
  const past = diff < 0;
  const hour = 3_600_000;
  const day = 24 * hour;
  let label: string;
  if (abs < 2 * hour) label = formatDuration(abs);
  else if (abs < day) label = `${Math.round(abs / hour)} h`;
  else {
    const days = Math.round(abs / day);
    if (days === 1) return past ? "yesterday" : "tomorrow";
    if (days < 7) label = `${days} days`;
    else return past ? formatDate(iso) : `on ${formatDate(iso)}`;
  }
  return past ? `${label} ago` : `in ${label}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The tool family shown in folded runs: `browser.navigate` → `browser`, `mcp__notion__x` → `notion`. */
export function toolFamily(tool: string): string {
  if (tool.startsWith("mcp__")) return tool.split("__")[1] ?? "mcp";
  return tool.split(/[._]/)[0] ?? tool;
}
