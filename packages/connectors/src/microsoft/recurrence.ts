import { PsycheError } from "@psyche/protocol";

/**
 * RFC 5545 `RRULE` lines (what the calendar tools take, as Google does) ↔ Graph
 * `patternedRecurrence` (`{ pattern, range }`). Only the shapes Graph can express are converted;
 * anything else is refused with `invalid_params` so the owner never gets a silently different
 * series. Dates are taken in UTC, because the event's start goes to Graph in UTC.
 *
 * Supported: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, BYDAY, BYMONTHDAY, BYMONTH, BYSETPOS
 * (one value), WKST, COUNT, UNTIL. Refused: EXDATE/RDATE and any second line, HOURLY/MINUTELY/
 * SECONDLY, BYHOUR/BYMINUTE/BYSECOND/BYWEEKNO/BYYEARDAY and the other BY* parts, plain BYDAY under
 * MONTHLY or YEARLY without an ordinal or BYSETPOS, and anything that mixes them.
 */

export interface GraphRecurrence {
  pattern: {
    type: string;
    interval?: number;
    daysOfWeek?: string[];
    firstDayOfWeek?: string;
    dayOfMonth?: number;
    month?: number;
    index?: string;
  };
  range: {
    type: string;
    startDate?: string;
    numberOfOccurrences?: number;
    endDate?: string;
    recurrenceTimeZone?: string;
  };
}

const DAY_NAMES: Record<string, string> = {
  SU: "sunday",
  MO: "monday",
  TU: "tuesday",
  WE: "wednesday",
  TH: "thursday",
  FR: "friday",
  SA: "saturday",
};
const CODE_BY_NAME = Object.fromEntries(Object.entries(DAY_NAMES).map(([c, n]) => [n, c]));
/** Index of the weekday in the JS `getUTCDay()` order (Sunday first). */
const CODES_BY_WEEKDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const INDEX_BY_ORD: Record<number, string> = {
  1: "first",
  2: "second",
  3: "third",
  4: "fourth",
  [-1]: "last",
};
const ORD_BY_INDEX = Object.fromEntries(
  Object.entries(INDEX_BY_ORD).map(([o, i]) => [i, Number(o)]),
);
const SUPPORTED_KEYS = new Set([
  "FREQ",
  "INTERVAL",
  "COUNT",
  "UNTIL",
  "BYDAY",
  "BYMONTHDAY",
  "BYMONTH",
  "BYSETPOS",
  "WKST",
]);

function refuse(msg: string): never {
  throw new PsycheError("invalid_params", `recurrence: ${msg}`);
}

interface Rule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  until?: string;
  byday: { code: string; ord?: number }[];
  bymonthday?: number;
  bymonth?: number;
  bysetpos?: number;
  wkst?: string;
}

function posInt(v: string, name: string): number {
  if (!/^\d+$/.test(v) || Number(v) < 1) refuse(`${name} must be a positive whole number`);
  return Number(v);
}

function ranged(v: string, name: string, min: number, max: number): number {
  if (!/^[+-]?\d+$/.test(v)) refuse(`${name} must be a whole number`);
  const n = Number(v);
  if (n < min || n > max) refuse(`${name}=${v} is out of range`);
  return n;
}

function isoDate(y: number, m: number, d: number): string | undefined {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d)
    return undefined;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseByday(v: string): Rule["byday"] {
  return v.split(",").map((tok) => {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(tok);
    if (m === null) refuse(`BYDAY=${tok} is not supported`);
    const code = m[2] as string;
    if (m[1] === undefined) return { code };
    return { code, ord: ranged(m[1], "BYDAY ordinal", -1, 4) };
  });
}

/** Splits one RRULE line into its parts, refusing anything Graph cannot express. */
function parseRrule(line: string): Rule {
  const text = line.trim();
  if (!/^RRULE:/i.test(text)) {
    refuse("only one RRULE line is supported (EXDATE, RDATE and other lines are not)");
  }
  const parts = new Map<string, string>();
  for (const part of text.slice("RRULE:".length).split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) refuse(`malformed part "${part.slice(0, 20)}"`);
    const key = part.slice(0, eq).toUpperCase();
    if (parts.has(key)) refuse(`${key} appears more than once`);
    if (!SUPPORTED_KEYS.has(key)) refuse(`${key} is not supported on Microsoft`);
    parts.set(key, part.slice(eq + 1).toUpperCase());
  }
  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") {
    refuse(`FREQ=${freq ?? "(missing)"} is not supported; use DAILY, WEEKLY, MONTHLY or YEARLY`);
  }
  const rule: Rule = {
    freq,
    interval: parts.has("INTERVAL") ? posInt(parts.get("INTERVAL") as string, "INTERVAL") : 1,
    byday: [],
  };
  if (parts.has("COUNT") && parts.has("UNTIL")) refuse("COUNT and UNTIL cannot both be set");
  if (parts.has("COUNT")) rule.count = posInt(parts.get("COUNT") as string, "COUNT");
  if (parts.has("UNTIL")) {
    const m = /^(\d{4})(\d{2})(\d{2})(T\d{6}Z)?$/.exec(parts.get("UNTIL") as string);
    const date = m === null ? undefined : isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (date === undefined) refuse("UNTIL must be YYYYMMDD or YYYYMMDDTHHMMSSZ");
    rule.until = date;
  }
  if (parts.has("BYDAY")) rule.byday = parseByday(parts.get("BYDAY") as string);
  if (parts.has("BYMONTHDAY")) {
    const v = parts.get("BYMONTHDAY") as string;
    if (v.includes(",")) refuse("BYMONTHDAY takes one day");
    rule.bymonthday = ranged(v, "BYMONTHDAY", 1, 31);
  }
  if (parts.has("BYMONTH")) {
    const v = parts.get("BYMONTH") as string;
    if (v.includes(",")) refuse("BYMONTH takes one month");
    rule.bymonth = ranged(v, "BYMONTH", 1, 12);
  }
  if (parts.has("BYSETPOS")) {
    const v = parts.get("BYSETPOS") as string;
    if (v.includes(",")) refuse("BYSETPOS with more than one value is not supported");
    rule.bysetpos = ranged(v, "BYSETPOS", -1, 4);
  }
  if (parts.has("WKST")) {
    const v = parts.get("WKST") as string;
    if (DAY_NAMES[v] === undefined) refuse(`WKST=${v} is not a weekday`);
    rule.wkst = v;
  }
  return rule;
}

function requireNone(rule: Rule, keys: (keyof Rule)[], where: string): void {
  for (const k of keys) {
    const v = rule[k];
    if (v !== undefined && !(Array.isArray(v) && v.length === 0)) {
      refuse(`${k.toUpperCase()} is not supported under ${where}`);
    }
  }
}

function ordinalIndex(ord: number): string {
  const index = INDEX_BY_ORD[ord];
  if (index === undefined) refuse(`ordinal ${ord} is not supported (use 1 to 4 or -1)`);
  return index;
}

/** The day-of-month part of MONTHLY and YEARLY: relative (weekday + index) or absolute. */
function monthDayPattern(
  rule: Rule,
  relative: "relativeMonthly" | "relativeYearly",
  absolute: "absoluteMonthly" | "absoluteYearly",
  startDay: number,
): { type: string; dayOfMonth?: number; daysOfWeek?: string[]; index?: string } {
  if (rule.byday.length > 0) {
    if (rule.bymonthday !== undefined) refuse("BYMONTHDAY cannot be combined with BYDAY");
    const ords = new Set(rule.byday.map((b) => b.ord));
    if (ords.size > 1) refuse("BYDAY ordinals must all be the same");
    const [ord] = [...ords];
    let index: string;
    if (ord === undefined) {
      if (rule.bysetpos === undefined) {
        refuse(
          "BYDAY without an ordinal or BYSETPOS means every such day of the month, which Microsoft cannot express",
        );
      }
      index = ordinalIndex(rule.bysetpos);
    } else {
      if (rule.bysetpos !== undefined) refuse("BYDAY with an ordinal cannot also have BYSETPOS");
      index = ordinalIndex(ord);
    }
    return {
      type: relative,
      daysOfWeek: rule.byday.map((b) => DAY_NAMES[b.code] as string),
      index,
    };
  }
  if (rule.bysetpos !== undefined) refuse("BYSETPOS needs BYDAY");
  return { type: absolute, dayOfMonth: rule.bymonthday ?? startDay };
}

/**
 * Converts one RRULE line to Graph `recurrence`. `startDate` is the event start's date (YYYY-MM-DD,
 * UTC); without it the series cannot be anchored, so it is refused.
 */
export function rruleToGraphRecurrence(
  lines: string[],
  startDate: string | undefined,
): GraphRecurrence {
  if (lines.length !== 1) refuse("only one RRULE line is supported (EXDATE and RDATE are not)");
  const rule = parseRrule(lines[0] as string);
  if (startDate === undefined) refuse("a recurring event needs a start");
  const anchor = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate);
  const start =
    anchor === null ? undefined : isoDate(Number(anchor[1]), Number(anchor[2]), Number(anchor[3]));
  if (start === undefined) refuse("the start date is not a valid YYYY-MM-DD");
  const [y, m, d] = start.split("-").map(Number) as [number, number, number];
  const startDay = d;
  const weekday = CODES_BY_WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] as string;
  const interval = rule.interval;

  let pattern: GraphRecurrence["pattern"];
  switch (rule.freq) {
    case "DAILY":
      requireNone(rule, ["byday", "bymonthday", "bymonth", "bysetpos"], "DAILY");
      pattern = { type: "daily", interval };
      break;
    case "WEEKLY": {
      requireNone(rule, ["bymonthday", "bymonth", "bysetpos"], "WEEKLY");
      if (rule.byday.some((b) => b.ord !== undefined)) {
        refuse("BYDAY ordinals are only supported under MONTHLY and YEARLY");
      }
      const days = rule.byday.length > 0 ? rule.byday.map((b) => b.code) : [weekday];
      pattern = {
        type: "weekly",
        interval,
        daysOfWeek: days.map((c) => DAY_NAMES[c] as string),
        firstDayOfWeek: DAY_NAMES[rule.wkst ?? "SU"] as string,
      };
      break;
    }
    case "MONTHLY":
      requireNone(rule, ["bymonth"], "MONTHLY");
      pattern = {
        ...monthDayPattern(rule, "relativeMonthly", "absoluteMonthly", startDay),
        interval,
      };
      break;
    case "YEARLY": {
      const month = rule.bymonth ?? m;
      pattern = {
        ...monthDayPattern(rule, "relativeYearly", "absoluteYearly", startDay),
        interval,
        month,
      };
      break;
    }
  }

  const range: GraphRecurrence["range"] = { type: "noEnd", startDate: start };
  if (rule.count !== undefined) {
    range.type = "numbered";
    range.numberOfOccurrences = rule.count;
  } else if (rule.until !== undefined) {
    if (rule.until < start) refuse("UNTIL is before the start");
    range.type = "endDate";
    range.endDate = rule.until;
  }
  return { pattern, range };
}

/**
 * Graph `recurrence` → one RRULE line, for reads. Returns `undefined` for a pattern this module
 * does not know, so a listing still shows the event instead of failing.
 */
export function graphRecurrenceToRrule(rec: GraphRecurrence): string | undefined {
  const p = rec.pattern;
  const days = (p.daysOfWeek ?? []).map((n) => CODE_BY_NAME[n]);
  if (days.some((c) => c === undefined)) return undefined;
  const parts: string[] = [];
  const prefix = (i: string | undefined) => {
    const ord = i === undefined ? undefined : ORD_BY_INDEX[i];
    return ord === undefined ? "" : String(ord);
  };
  const relative = () => days.map((c) => `${prefix(p.index)}${c}`).join(",");
  let freq: string;
  switch (p.type) {
    case "daily":
      freq = "DAILY";
      break;
    case "weekly":
      freq = "WEEKLY";
      parts.push(`BYDAY=${days.join(",")}`);
      if (p.firstDayOfWeek !== undefined && p.firstDayOfWeek !== "sunday") {
        parts.push(`WKST=${CODE_BY_NAME[p.firstDayOfWeek] ?? "SU"}`);
      }
      break;
    case "absoluteMonthly":
      freq = "MONTHLY";
      parts.push(`BYMONTHDAY=${p.dayOfMonth}`);
      break;
    case "relativeMonthly":
      freq = "MONTHLY";
      parts.push(`BYDAY=${relative()}`);
      break;
    case "absoluteYearly":
      freq = "YEARLY";
      parts.push(`BYMONTH=${p.month}`, `BYMONTHDAY=${p.dayOfMonth}`);
      break;
    case "relativeYearly":
      freq = "YEARLY";
      parts.push(`BYMONTH=${p.month}`, `BYDAY=${relative()}`);
      break;
    default:
      return undefined;
  }
  const head = [`FREQ=${freq}`];
  if (p.interval !== undefined && p.interval !== 1) head.push(`INTERVAL=${p.interval}`);
  const r = rec.range;
  const tail: string[] = [];
  if (r.type === "numbered" && r.numberOfOccurrences !== undefined) {
    tail.push(`COUNT=${r.numberOfOccurrences}`);
  } else if (r.type === "endDate" && r.endDate !== undefined) {
    tail.push(`UNTIL=${r.endDate.replace(/-/g, "")}`);
  }
  return `RRULE:${[...head, ...parts, ...tail].join(";")}`;
}
