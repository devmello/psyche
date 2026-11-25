import { parseAtInstant } from "@psyche/agent-core";
import { type OsTextLanguage, osTextLanguage } from "@psyche/notifications";
import type { ApprovalRequestInput, PermissionBroker } from "@psyche/protocol";

/**
 * The schedule approval card in plain words. The agent's `schedule` tool carries a cron
 * expression, a kind and an internal prompt; the owner is asked about when and what. This turns
 * `0 9 26 11 *` into "tomorrow at 9:00 AM", in the owner's language and zone, and moves the raw
 * fields out of the card's rows into its "Details" disclosure (a `…Ref` key, see
 * `isLevel2Key` in packages/ui/src/blocks/approval-details.tsx). The binding is untouched: it
 * hashes the real arguments, so what the owner approves is what runs.
 */

type Words = {
  /** "Remind you {when}: {title}" */
  remind: string;
  /** "{day} at {time}" */
  at: string;
  /** "Every day at {time}" */
  daily: string;
  /** "Every weekday at {time}" */
  weekdays: string;
  /** "Every {days} at {time}" */
  weekly: string;
  /** "On day {day} of every month at {time}" */
  monthly: string;
  /** Anything else */
  fallback: string;
};

export const SCHEDULE_WORDS: Readonly<Record<OsTextLanguage, Words>> = {
  en: {
    remind: "Remind you {when}: {title}",
    at: "{day} at {time}",
    daily: "Every day at {time}",
    weekdays: "Every weekday at {time}",
    weekly: "Every {days} at {time}",
    monthly: "On day {day} of every month at {time}",
    fallback: "On a schedule",
  },
  ar: {
    remind: "تذكيرك {when}: {title}",
    at: "{day} في {time}",
    daily: "كل يوم في {time}",
    weekdays: "كل يوم عمل في {time}",
    weekly: "كل {days} في {time}",
    monthly: "في اليوم {day} من كل شهر في {time}",
    fallback: "وفق جدول زمني",
  },
  de: {
    remind: "Erinnerung an dich {when}: {title}",
    at: "{day} um {time}",
    daily: "Jeden Tag um {time}",
    weekdays: "Jeden Werktag um {time}",
    weekly: "Jeden {days} um {time}",
    monthly: "Am {day}. jedes Monats um {time}",
    fallback: "Nach Zeitplan",
  },
  es: {
    remind: "Recordarte {when}: {title}",
    at: "{day} a las {time}",
    daily: "Todos los días a las {time}",
    weekdays: "Todos los días laborables a las {time}",
    weekly: "Cada {days} a las {time}",
    monthly: "El día {day} de cada mes a las {time}",
    fallback: "Según un horario",
  },
  fr: {
    remind: "Vous rappeler {when} : {title}",
    at: "{day} à {time}",
    daily: "Tous les jours à {time}",
    weekdays: "Chaque jour ouvré à {time}",
    weekly: "Chaque {days} à {time}",
    monthly: "Le {day} de chaque mois à {time}",
    fallback: "Selon un calendrier",
  },
  hi: {
    remind: "आपको याद दिलाएँ {when}: {title}",
    at: "{day}, {time}",
    daily: "हर दिन {time}",
    weekdays: "हर कार्यदिवस {time}",
    weekly: "हर {days} {time}",
    monthly: "हर महीने की {day} तारीख़ को {time}",
    fallback: "एक शेड्यूल पर",
  },
  it: {
    remind: "Ricordarti {when}: {title}",
    at: "{day} alle {time}",
    daily: "Ogni giorno alle {time}",
    weekdays: "Ogni giorno feriale alle {time}",
    weekly: "Ogni {days} alle {time}",
    monthly: "Il giorno {day} di ogni mese alle {time}",
    fallback: "Secondo un programma",
  },
  ja: {
    remind: "{when}にリマインド: {title}",
    at: "{day} {time}",
    daily: "毎日 {time}",
    weekdays: "平日の毎日 {time}",
    weekly: "毎週{days} {time}",
    monthly: "毎月{day}日 {time}",
    fallback: "スケジュールに従って",
  },
  ko: {
    remind: "{when}에 알림: {title}",
    at: "{day} {time}",
    daily: "매일 {time}",
    weekdays: "평일마다 {time}",
    weekly: "매주 {days} {time}",
    monthly: "매월 {day}일 {time}",
    fallback: "일정에 따라",
  },
  pt: {
    remind: "Lembrar você {when}: {title}",
    at: "{day} às {time}",
    daily: "Todos os dias às {time}",
    weekdays: "Todos os dias úteis às {time}",
    weekly: "Toda {days} às {time}",
    monthly: "No dia {day} de cada mês às {time}",
    fallback: "Em um cronograma",
  },
  zh: {
    remind: "{when}提醒你：{title}",
    at: "{day} {time}",
    daily: "每天 {time}",
    weekdays: "每个工作日 {time}",
    weekly: "每{days} {time}",
    monthly: "每月{day}日 {time}",
    fallback: "按计划",
  },
};

const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);

export interface ScheduleCardInput {
  title: string;
  /** `at` for a one-time run; else `kind` and `schedule`. */
  at?: string | undefined;
  kind?: string | undefined;
  schedule?: string | undefined;
  /** The automation's zone (IANA); the owner's zone when the agent gave none. */
  timezone: string;
}

export interface ScheduleCardEnv {
  now: number;
  language: OsTextLanguage;
  /** A BCP 47 tag for Intl (day names, the 12 or 24 hour clock). */
  locale: string;
}

const INT = /^\d{1,2}$/;

/** The days a cron weekday field names (0 = Sunday), or undefined when it is not a plain list. */
function cronDays(field: string): Set<number> | undefined {
  if (field === "*") return new Set([0, 1, 2, 3, 4, 5, 6]);
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range !== null) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (a > b || b > 7) return undefined;
      for (let d = a; d <= b; d += 1) days.add(d % 7);
    } else if (/^\d$/.test(part) && Number(part) <= 7) {
      days.add(Number(part) % 7);
    } else return undefined;
  }
  return days;
}

function ymd(ms: number, timeZone: string): [number, number, number] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return [get("year"), get("month"), get("day")];
}

/** The date part of a one-time run: today, tomorrow, or a weekday and date. */
function dayText(ms: number, timeZone: string, env: ScheduleCardEnv): string {
  const [y, m, d] = ymd(ms, timeZone);
  const [ny, nm, nd] = ymd(env.now, timeZone);
  const diff = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ny, nm - 1, nd)) / 86_400_000);
  if (diff === 0 || diff === 1) {
    return new Intl.RelativeTimeFormat(env.locale, { numeric: "auto" }).format(diff, "day");
  }
  return new Intl.DateTimeFormat(env.locale, {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(ms);
}

const clock = (ms: number, timeZone: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" }).format(ms);

const cap = (text: string, locale: string): string =>
  text === "" ? text : text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);

/**
 * The schedule in words: "Tomorrow at 9:00 AM", "Every weekday at 9:00 AM", or the fallback
 * "On a schedule" for anything a person would not say in one line (steps like every 5 minutes,
 * ranges of days of the month, an interval).
 */
export function scheduleWords(input: ScheduleCardInput, env: ScheduleCardEnv): string {
  const w = SCHEDULE_WORDS[env.language];
  const tz = input.timezone;
  const at = (ms: number) =>
    fill(w.at, { day: dayText(ms, tz, env), time: clock(ms, tz, env.locale) });
  try {
    if (input.at !== undefined) {
      const ms = parseAtInstant(input.at, tz);
      return ms === undefined ? w.fallback : at(ms);
    }
    const fields = (input.schedule ?? "").trim().split(/\s+/);
    if (input.kind !== "cron" || fields.length !== 5) return w.fallback;
    const [min, hour, dom, month, dow] = fields as [string, string, string, string, string];
    if (!INT.test(min) || !INT.test(hour) || Number(min) > 59 || Number(hour) > 23) {
      return w.fallback;
    }
    // Wall-clock time only: formatted in UTC from a UTC date, so no zone shifts it.
    const time = clock(Date.UTC(2000, 0, 1, Number(hour), Number(min)), "UTC", env.locale);
    if (dom === "*" && month === "*") {
      const days = cronDays(dow);
      if (days === undefined || days.size === 0) return w.fallback;
      if (days.size === 7) return fill(w.daily, { time });
      if ([1, 2, 3, 4, 5].every((d) => days.has(d)) && days.size === 5) {
        return fill(w.weekdays, { time });
      }
      const names = [1, 2, 3, 4, 5, 6, 0]
        .filter((d) => days.has(d))
        .map((d) =>
          new Intl.DateTimeFormat(env.locale, { timeZone: "UTC", weekday: "long" }).format(
            Date.UTC(2023, 0, 1 + d),
          ),
        );
      const list = new Intl.ListFormat(env.locale, { type: "conjunction" }).format(names);
      return fill(w.weekly, { days: list, time });
    }
    if (dow !== "*" || !INT.test(dom) || Number(dom) < 1 || Number(dom) > 31) return w.fallback;
    if (month === "*") return fill(w.monthly, { day: dom, time });
    if (!INT.test(month) || Number(month) < 1 || Number(month) > 12) return w.fallback;
    // A date with no year: the next one at or after now, this year or the next.
    const [year] = ymd(env.now, tz);
    for (const y of [year as number, (year as number) + 1]) {
      const iso = `${y}-${month.padStart(2, "0")}-${dom.padStart(2, "0")}T${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
      const ms = parseAtInstant(iso, tz);
      if (ms !== undefined && ms >= env.now - 60_000) return at(ms);
    }
    return w.fallback;
  } catch {
    return w.fallback;
  }
}

const REMINDER_PREFIX = /^\s*(?:reminder|remind me)\s*[:\-–—]?\s*/i;

/** The card's title: "Remind you tomorrow at 9:00 AM: call the dentist". */
export function scheduleSummary(input: ScheduleCardInput, env: ScheduleCardEnv): string {
  const w = SCHEDULE_WORDS[env.language];
  const when = scheduleWords(input, env);
  const prefixed = REMINDER_PREFIX.test(input.title);
  const title = input.title.replace(REMINDER_PREFIX, "").trim() || input.title.trim();
  return prefixed && input.at !== undefined
    ? fill(w.remind, { when, title })
    : `${cap(when, env.locale)}: ${title}`;
}

export interface ScheduleCardDeps {
  /** The owner's zone now (the setting, else the Mac's). */
  zone: () => string;
  now: () => number;
  /** `ui.language` as stored (a tag, "system" or unset). */
  language: () => unknown;
  /** The Mac's locale, for "system". */
  systemLocale: () => string;
}

function envOf(deps: ScheduleCardDeps): ScheduleCardEnv {
  const setting = deps.language();
  const system = deps.systemLocale();
  const language = osTextLanguage(setting, system);
  const tag = typeof setting === "string" && setting !== "system" ? setting : system;
  let locale = tag;
  try {
    new Intl.DateTimeFormat(tag);
  } catch {
    locale = language;
  }
  return { now: deps.now(), language, locale };
}

/**
 * Rewrites the `schedule` tool's card: a plain title, one "When" row, and the raw cron, kind and
 * prompt kept in the Details disclosure. Other requests pass through as they are.
 */
export function withScheduleCard<B extends PermissionBroker>(broker: B, deps: ScheduleCardDeps): B {
  return new Proxy(broker, {
    get(target, prop, receiver) {
      if (prop === "requestApproval") {
        return (input: ApprovalRequestInput) => {
          const details = input.details as Record<string, unknown> | undefined;
          const p = details?.params as Record<string, unknown> | undefined;
          if (details?.tool !== "schedule" || p === undefined || typeof p.title !== "string") {
            return target.requestApproval(input);
          }
          const str = (v: unknown) => (typeof v === "string" ? v : undefined);
          const card: ScheduleCardInput = {
            title: p.title,
            at: str(p.at),
            kind: str(p.kind),
            schedule: str(p.schedule),
            timezone: str(p.timezone) ?? deps.zone(),
          };
          let env: ScheduleCardEnv;
          let summary: string;
          let when: string;
          try {
            env = envOf(deps);
            summary = scheduleSummary(card, env);
            when = scheduleWords(card, env);
          } catch {
            return target.requestApproval(input);
          }
          const { params: _raw, ...rest } = details;
          return target.requestApproval({
            ...input,
            summary,
            details: {
              ...rest,
              params: { when },
              rawScheduleRef: JSON.stringify({
                kind: card.at === undefined ? card.kind : "reminder",
                at: card.at,
                schedule: card.schedule,
                timezone: card.timezone,
                prompt: str(p.prompt),
              }),
            },
          });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
