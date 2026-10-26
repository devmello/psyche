import { type Formatters, IntlMessageFormat } from "intl-messageformat";
import {
  type Direction,
  type DirectionSetting,
  resolveDirection,
  resolveMessageLocale,
  runtimeLocale,
} from "./locale.ts";
import { en, type MessageId } from "./messages/index.ts";
import { CATALOGUES } from "./messages/locales/index.ts";

/** Values a message's `{placeholders}` take. */
export type MessageValues = Readonly<Record<string, string | number | boolean | Date | null>>;

export interface I18n {
  /** The format locale (numbers, dates, times). */
  readonly locale: string;
  /** The catalogue's locale; also the document's `lang`. */
  readonly messageLocale: string;
  readonly dir: Direction;
  /** The time zone dates and times are shown in; undefined is the runtime's (the owner's). */
  readonly timeZone: string | undefined;
  t(id: MessageId, values?: MessageValues): string;
  number(n: number, options?: Intl.NumberFormatOptions): string;
  percent(fraction: number, options?: Intl.NumberFormatOptions): string;
  date(value: string | number | Date, options?: Intl.DateTimeFormatOptions): string;
  time(value: string | number | Date, options?: Intl.DateTimeFormatOptions): string;
  dateTime(value: string | number | Date, options?: Intl.DateTimeFormatOptions): string;
  list(items: readonly string[], type?: "conjunction" | "disjunction"): string;
}

export interface I18nOptions {
  /** The format locale (numbers, dates, times). */
  locale?: string;
  /** The text's language (`ui.language`): "system" or a shipped message locale. */
  language?: string;
  direction?: DirectionSetting;
  /** Pins a time zone (tests and stories use "UTC"); else `setDefaultTimeZone`'s, else the runtime's. */
  timeZone?: string;
}

let defaultTimeZone: string | undefined;

/**
 * The time zone for i18n instances created without one. Unset in the app, so times follow the
 * owner's clock; Storybook and the test setups pin "UTC" so baselines and assertions are stable.
 */
export function setDefaultTimeZone(timeZone: string | undefined): void {
  defaultTimeZone = timeZone;
}

const toDate = (v: string | number | Date) => (v instanceof Date ? v : new Date(v));

export function createI18n(options: I18nOptions = {}): I18n {
  const locale = options.locale ?? runtimeLocale();
  const messageLocale = resolveMessageLocale(options.language ?? "system", locale);
  const dir = resolveDirection(options.direction ?? "auto", messageLocale);
  const catalogue = CATALOGUES[messageLocale];
  const timeZone = options.timeZone ?? defaultTimeZone;
  const compiled = new Map<MessageId, IntlMessageFormat>();
  const numbers = new Map<string, Intl.NumberFormat>();
  const dates = new Map<string, Intl.DateTimeFormat>();
  const numberFormat = (o: Intl.NumberFormatOptions = {}) => {
    const key = JSON.stringify(o);
    let f = numbers.get(key);
    if (f === undefined) {
      f = new Intl.NumberFormat(locale, o);
      numbers.set(key, f);
    }
    return f;
  };
  // An explicit `timeZone` wins (calendar days stored as UTC midnight stay in UTC).
  const dateFormat = (requested: Intl.DateTimeFormatOptions) => {
    const o =
      timeZone === undefined || requested.timeZone !== undefined
        ? requested
        : { ...requested, timeZone };
    const key = JSON.stringify(o);
    let f = dates.get(key);
    if (f === undefined) {
      f = new Intl.DateTimeFormat(locale, o);
      dates.set(key, f);
    }
    return f;
  };
  // Numbers and dates inside messages follow the format locale; plural and select rules follow
  // the message's own language (English text under a French region still says "1 day", and an
  // English fallback inside another catalogue keeps English plurals).
  const formatters: Formatters = {
    getNumberFormat: (_l, o) => numberFormat(o as Intl.NumberFormatOptions | undefined),
    getDateTimeFormat: (_l, o) => dateFormat(o ?? {}),
    getPluralRules: (l, o) => new Intl.PluralRules(l, o),
  };
  const compile = (source: string, lang: string) =>
    new IntlMessageFormat(source, lang, undefined, { ignoreTag: true, formatters });
  const english = new Map<MessageId, IntlMessageFormat>();
  const englishFor = (id: MessageId) => {
    let f = english.get(id);
    if (f === undefined) {
      f = compile(en[id], "en");
      english.set(id, f);
    }
    return f;
  };
  type Values = Record<string, string | number | boolean | Date>;
  return {
    locale,
    messageLocale,
    dir,
    timeZone,
    t(id, values) {
      if (en[id] === undefined) return id;
      let f = compiled.get(id);
      if (f === undefined) {
        // Per id: a message the catalogue lacks, or one that does not parse, is the English one.
        const translated = catalogue[id];
        try {
          f = translated === undefined ? englishFor(id) : compile(translated, messageLocale);
        } catch {
          f = englishFor(id);
        }
        compiled.set(id, f);
      }
      let out: unknown;
      try {
        out = f.format(values as Values);
      } catch {
        // A translation that names a value the code does not pass: the English one.
        out = englishFor(id).format(values as Values);
      }
      return typeof out === "string" ? out : String(out);
    },
    number: (n, o) => numberFormat(o).format(n),
    percent: (fraction, o) => numberFormat({ style: "percent", ...o }).format(fraction),
    date: (v, o = { month: "short", day: "numeric" }) => dateFormat(o).format(toDate(v)),
    time: (v, o = { hour: "numeric", minute: "2-digit" }) => dateFormat(o).format(toDate(v)),
    dateTime: (v, o = { dateStyle: "medium", timeStyle: "short" }) =>
      dateFormat(o).format(toDate(v)),
    list: (items, type = "conjunction") => {
      try {
        return new Intl.ListFormat(locale, { type }).format(items);
      } catch {
        return items.join(", ");
      }
    },
  };
}

let active: I18n = createI18n();

/** The i18n the UI renders with (set by `I18nProvider`; English and the runtime locale until then). */
export function activeI18n(): I18n {
  return active;
}

export function setActiveI18n(next: I18n): void {
  active = next;
}

/** A catalogue string, formatted with the active locale. Usable in components and helpers. */
export function t(id: MessageId, values?: MessageValues): string {
  return active.t(id, values);
}

/** True when `id` is in the English catalogue (dynamic ids built from data). */
export function isMessageId(id: string): id is MessageId {
  return Object.hasOwn(en, id);
}
