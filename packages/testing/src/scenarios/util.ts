import type { Json } from "./types.ts";

/** `a.b[0].c` lookup (README "Matchers"). */
export function getPath(value: unknown, path: string): unknown {
  let cur = value;
  for (const part of path.split(".")) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (m === null) return undefined;
    if (m[1] !== "") cur = (cur as Json | undefined)?.[m[1] as string];
    for (const idx of (m[2] ?? "").match(/\d+/g) ?? []) {
      cur = Array.isArray(cur) ? cur[Number(idx)] : undefined;
    }
  }
  return cur;
}

const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? null));
const has = (v: unknown, s: string) => text(v).toLowerCase().includes(s.toLowerCase());
const anyOf = (v: unknown, f: (x: unknown) => boolean) => (Array.isArray(v) ? v.some(f) : f(v));

function host(v: unknown): string | undefined {
  try {
    return new URL(String(v)).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** One matcher (`equals`, `contains`, `notContains`, `matches`, `containsAny`, `hostIn`, `absent`). */
export function matchOne(v: unknown, m: Json): boolean {
  if ("absent" in m) return (v === undefined) === m.absent;
  if ("equals" in m) return JSON.stringify(v) === JSON.stringify(m.equals);
  if ("contains" in m) return anyOf(v, (x) => has(x, String(m.contains)));
  if ("notContains" in m) return !anyOf(v, (x) => has(x, String(m.notContains)));
  if ("containsAny" in m)
    return (m.containsAny as string[]).some((s) => anyOf(v, (x) => has(x, s)));
  if ("matches" in m) return anyOf(v, (x) => new RegExp(String(m.matches)).test(text(x)));
  if ("hostIn" in m) return anyOf(v, (x) => (m.hostIn as string[]).includes(host(x) ?? ""));
  return false;
}

/** Every `path → matcher` of `spec` holds on `subject` (an absent spec matches everything). */
export function matches(subject: unknown, spec: unknown): boolean {
  if (spec === undefined) return true;
  return Object.entries(spec as Json).every(([p, m]) => matchOne(getPath(subject, p), m as Json));
}

/** `${name[i].field}` substitution from earlier captures. */
export function substitute<T>(value: T, captures: Record<string, unknown>): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (all, path: string) => {
      const v = getPath(captures, path);
      return v === undefined ? all : String(v);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, captures)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substitute(v, captures)]),
    ) as T;
  }
  return value;
}

export function inRange(n: number, a: Json, defaultMin = 1): boolean {
  if (typeof a.equals === "number") return n === a.equals;
  if (typeof a.count === "number") return n === a.count;
  const min = typeof a.min === "number" ? a.min : a.max === undefined ? defaultMin : 0;
  return n >= min && (typeof a.max !== "number" || n <= a.max);
}

export function rangeText(a: Json): string {
  if (typeof a.equals === "number") return `= ${a.equals}`;
  if (typeof a.count === "number") return `= ${a.count}`;
  return `in ${a.min ?? (a.max === undefined ? 1 : 0)}..${a.max ?? "∞"}`;
}

export function originOf(url: unknown): string | undefined {
  try {
    return new URL(String(url)).origin;
  } catch {
    return undefined;
  }
}

// ---- time --------------------------------------------------------------------------------

/** Offset of `tz` at `ms`, in minutes east of UTC. */
export function tzOffset(tz: string, ms: number): number {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(new Date(ms))
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return m === null ? 0 : (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** Local wall time in `tz` (`date`, minutes after midnight, two-letter weekday). */
export function localParts(ms: number, tz: string) {
  const local = new Date(ms + tzOffset(tz, ms) * 60_000);
  const date = local.toISOString().slice(0, 10);
  const weekday = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][local.getUTCDay()] as string;
  return { date, minutes: local.getUTCHours() * 60 + local.getUTCMinutes(), weekday };
}

/** Instant of a local wall time in `tz`. */
export function fromLocal(date: string, minutes: number, tz: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000;
  return guess - tzOffset(tz, guess - tzOffset(tz, guess) * 60_000) * 60_000;
}

/** ISO-8601 with the zone's offset, e.g. `2026-10-23T11:00:00-07:00`. */
export function isoInZone(ms: number, tz: string): string {
  const off = tzOffset(tz, ms);
  const local = new Date(ms + off * 60_000).toISOString().slice(0, 19);
  const a = Math.abs(off);
  const hh = String(Math.floor(a / 60)).padStart(2, "0");
  return `${local}${off < 0 ? "-" : "+"}${hh}:${String(a % 60).padStart(2, "0")}`;
}

export const hhmm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** ISO-8601 duration (`PT31M`, `P1DT2H`) in ms. */
export function durationMs(iso: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (m === null) throw new Error(`bad duration ${iso}`);
  const [d, h, min, s] = m.slice(1).map((x) => Number(x ?? 0)) as [number, number, number, number];
  return (((d * 24 + h) * 60 + min) * 60 + s) * 1000;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Deterministic slot parser for lines like `Thu Oct 22, 4:00-4:45 PM` (README `proposed_slots`):
 * a start without AM/PM takes the end's, unless that would put it after the end.
 */
export function parseSlots(body: string, year: number, tz: string) {
  const re =
    /\b(?:mon|tue|wed|thu|fri|sat|sun)\w*\s+([a-z]{3})\w*\s+(\d{1,2}),?\s+(\d{1,2}):(\d{2})\s*(am|pm)?\s*[-–]\s*(\d{1,2}):(\d{2})\s*(am|pm)/gi;
  const out: { start: string; end: string; s: number; e: number }[] = [];
  for (const m of body.matchAll(re)) {
    const month = MONTHS.indexOf((m[1] ?? "").toLowerCase()) + 1;
    if (month === 0) continue;
    const date = `${year}-${String(month).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
    const to24 = (h: number, ap: string) => (h % 12) + (ap.toLowerCase() === "pm" ? 12 : 0);
    const endAp = m[8] ?? "am";
    const end = to24(Number(m[6]), endAp) * 60 + Number(m[7]);
    let start = to24(Number(m[3]), m[5] ?? endAp) * 60 + Number(m[4]);
    if (m[5] === undefined && start > end) start -= 12 * 60;
    const s = fromLocal(date, start, tz);
    const e = fromLocal(date, end, tz);
    out.push({ start: isoInZone(s, tz), end: isoInZone(e, tz), s, e });
  }
  return out;
}
