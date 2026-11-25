/**
 * Due dates in words, resolved by code and never by the model (design 3.3 "Due date"). The phrase
 * is read against the time the text was sent, in the owner's zone: a bare day means 17:00 that
 * day, "EOD" is 17:00, "tonight" is 21:00, "next week" is Friday of next week at half confidence,
 * and "soon" or "later" gives no date. English, Spanish, German and French day words, plus ISO
 * dates; an unknown phrase gives no date, which the ledger shows as "No date".
 */

import type { LoopDueKind } from "../graph/store.ts";
import { foldCue } from "./cues.ts";
import { DAY_MS, localDay, localTime } from "./due.ts";

export interface ParsedDue {
  /** ISO instant, or null when the words give no date. */
  at: string | null;
  kind: LoopDueKind;
  confidence: number;
}

const NONE: ParsedDue = { at: null, kind: "none", confidence: 0 };

const WEEKDAY_WORDS: [number, string][] = [
  [1, "monday|mon|lunes|montag|lundi|lunedì|segunda"],
  [2, "tuesday|tue|tues|martes|dienstag|mardi|martedì|terça"],
  [3, "wednesday|wed|miércoles|miercoles|mittwoch|mercredi|mercoledì|quarta"],
  [4, "thursday|thu|thur|thurs|jueves|donnerstag|jeudi|giovedì|quinta"],
  [5, "friday|fri|viernes|freitag|vendredi|venerdì|sexta"],
  [6, "saturday|sat|sábado|sabado|samstag|samedi|sabato"],
  [0, "sunday|sun|domingo|sonntag|dimanche|domenica"],
];

const edge = (body: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "iu");

const RE_ISO = /(\d{4})-(\d{2})-(\d{2})/;
const RE_EOD = edge("eod|cob|end of (?:the )?day|fin del día|ende des tages|fin de journée");
const RE_TONIGHT = edge("tonight|esta noche|heute abend|ce soir|stasera|hoje à noite");
const RE_TODAY = edge("today|hoy|heute|aujourd'hui|oggi|hoje|this (?:morning|afternoon|evening)");
const RE_TOMORROW = edge("tomorrow|mañana|morgen|demain|domani|amanhã");
const RE_NEXT_WEEK = edge("next week|la próxima semana|nächste woche|la semaine prochaine");
const RE_END_OF_WEEK = edge("end of (?:the )?week|eow|this week|esta semana|diese woche");
const RE_NEXT = edge("next|próximo|nächsten|prochain");
const RE_TIME =
  /(?:\bat\s+|\bby\s+|\bum\s+|\ba las\s+|\bà\s+)?(\d{1,2})(?::(\d\d))?\s?(am|pm|h)?\b/i;
const WEEKDAY_RES = WEEKDAY_WORDS.map(([n, words]) => [n, edge(words)] as const);

function shift(day: { y: number; m: number; d: number }, days: number) {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** `hour:minute` of a bare clock time in the phrase, when one is given with am, pm or `at`. */
function clock(text: string): { h: number; min: number } | undefined {
  const m = RE_TIME.exec(text);
  if (m === null) return undefined;
  const explicit =
    m[3] !== undefined || /^(?:at|by|um|a las|à)\s/i.test(m[0]) || m[2] !== undefined;
  if (!explicit) return undefined;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  const mer = m[3]?.toLowerCase();
  if (mer === "pm" && h < 12) h += 12;
  if (mer === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return undefined;
  return { h, min };
}

export function parseDue(
  phrase: string | null | undefined,
  sentAtMs: number,
  tz: string,
): ParsedDue {
  if (phrase === null || phrase === undefined || phrase.trim() === "") return NONE;
  const text = foldCue(phrase).toLowerCase();
  const today = localDay(sentAtMs, tz);
  const at = (day: { y: number; m: number; d: number }, hour: number, min = 0): string =>
    new Date(localTime(day, hour, tz) + min * 60_000).toISOString();
  const time = clock(text);
  const stamp = (day: { y: number; m: number; d: number }, defaultHour: number): string =>
    time === undefined ? at(day, defaultHour) : at(day, time.h, time.min);

  const iso = RE_ISO.exec(text);
  if (iso !== null) {
    const day = { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
    if (day.m < 1 || day.m > 12 || day.d < 1 || day.d > 31) return NONE;
    return { at: stamp(day, 17), kind: "explicit", confidence: 0.9 };
  }
  if (RE_TONIGHT.test(text)) return { at: stamp(today, 21), kind: "explicit", confidence: 0.85 };
  if (RE_EOD.test(text)) return { at: at(today, 17), kind: "explicit", confidence: 0.85 };
  if (RE_TOMORROW.test(text))
    return { at: stamp(shift(today, 1), 17), kind: "explicit", confidence: 0.85 };

  const weekday = WEEKDAY_RES.find(([, re]) => re.test(text));
  if (weekday !== undefined) {
    const want = weekday[0];
    let ahead = (want - today.weekday + 7) % 7 || 7;
    // "next Friday" said on a Monday means the Friday of next week, not this one.
    if (RE_NEXT.test(text) && ahead <= (7 - today.weekday) % 7) ahead += 7;
    return { at: stamp(shift(today, ahead), 17), kind: "explicit", confidence: 0.85 };
  }
  if (RE_NEXT_WEEK.test(text)) {
    const toFriday = (5 - today.weekday + 7) % 7;
    return { at: at(shift(today, toFriday + 7), 17), kind: "inferred", confidence: 0.5 };
  }
  if (RE_END_OF_WEEK.test(text)) {
    const toFriday = (5 - today.weekday + 7) % 7;
    return { at: at(shift(today, toFriday), 17), kind: "inferred", confidence: 0.7 };
  }
  if (RE_TODAY.test(text)) return { at: stamp(today, 17), kind: "explicit", confidence: 0.85 };
  return NONE;
}

export interface ModelDue {
  text: string | null;
  date: string | null;
  time: string | null;
  kind: "explicit" | "inferred" | "none";
  confidence: number;
}

const MAX_FUTURE_DAYS = 400;
const MAX_PAST_DAYS = 1;

/**
 * The due date the ledger stores. The parser reads the phrase; the model's date is only a
 * cross-check. They agree: the lower confidence. They disagree: the parser wins and confidence
 * drops to 0.5 at most. The parser finds nothing but the model has a date: the model's date,
 * inferred, 0.5 at most. A date outside the window around `sentAt` is junk.
 */
export function resolveDue(
  model: ModelDue,
  sentAtMs: number,
  tz: string,
): ParsedDue & { text: string | null } {
  const text =
    model.text === null || model.text.trim() === "" ? null : model.text.trim().slice(0, 80);
  const parsed = parseDue(text, sentAtMs, tz);
  const sane = (iso: string): boolean => {
    const t = Date.parse(iso);
    return (
      !Number.isNaN(t) &&
      t >= sentAtMs - MAX_PAST_DAYS * DAY_MS &&
      t <= sentAtMs + MAX_FUTURE_DAYS * DAY_MS
    );
  };
  const dayOf = (iso: string): string => {
    const d = localDay(Date.parse(iso), tz);
    return `${d.y}-${d.m}-${d.d}`;
  };
  const modelAt =
    model.date !== null && /^\d{4}-\d{2}-\d{2}$/.test(model.date) && model.kind !== "none"
      ? stampDate(model.date, model.time, tz)
      : null;
  if (parsed.at !== null) {
    if (!sane(parsed.at)) return { ...NONE, text };
    if (modelAt === null || dayOf(modelAt) === dayOf(parsed.at))
      return { ...parsed, confidence: Math.min(parsed.confidence, model.confidence || 1), text };
    return { ...parsed, confidence: Math.min(parsed.confidence, 0.5), text };
  }
  if (modelAt !== null && sane(modelAt))
    return { at: modelAt, kind: "inferred", confidence: Math.min(model.confidence, 0.5), text };
  return { ...NONE, text };
}

function stampDate(date: string, time: string | null, tz: string): string | null {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const hm = time !== null && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : "17:00";
  const [h, min] = hm.split(":").map(Number) as [number, number];
  return new Date(localTime({ y, m, d }, h, tz) + min * 60_000).toISOString();
}
