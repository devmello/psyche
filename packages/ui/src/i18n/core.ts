import { type Formatters, IntlMessageFormat } from "intl-messageformat";
import {
  type Direction,
  type DirectionSetting,
  messageLocaleFor,
  resolveDirection,
  runtimeLocale,
} from "./locale.ts";
import { type Catalogue, en, type MessageId } from "./messages/index.ts";

/** Values a message's `{placeholders}` take. */
export type MessageValues = Readonly<Record<string, string | number | boolean | Date | null>>;

/** Shipped catalogues by message locale; a missing id falls back to English. */
const CATALOGUES: Readonly<Record<string, Partial<Catalogue>>> = { en };

export interface I18n {
  /** The format locale (numbers, dates, times). */
  readonly locale: string;
  /** The catalogue's locale; also the document's `lang`. */
  readonly messageLocale: string;
  readonly dir: Direction;
  t(id: MessageId, values?: MessageValues): string;
  number(n: number, options?: Intl.NumberFormatOptions): string;
  percent(fraction: number, options?: Intl.NumberFormatOptions): string;
  date(value: string | number | Date, options?: Intl.DateTimeFormatOptions): string;
  time(value: string | number | Date, options?: Intl.DateTimeFormatOptions): string;
  dateTime(value: string | number | Date, options?: Intl.DateTimeFormatOptions): string;
  list(items: readonly string[], type?: "conjunction" | "disjunction"): string;
}

export interface I18nOptions {
  locale?: string;
  direction?: DirectionSetting;
}

const toDate = (v: string | number | Date) => (v instanceof Date ? v : new Date(v));

export function createI18n(options: I18nOptions = {}): I18n {
  const locale = options.locale ?? runtimeLocale();
  const messageLocale = messageLocaleFor(locale);
  const dir = resolveDirection(options.direction ?? "auto", messageLocale);
  const catalogue = CATALOGUES[messageLocale] ?? en;
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
  const dateFormat = (o: Intl.DateTimeFormatOptions) => {
    const key = JSON.stringify(o);
    let f = dates.get(key);
    if (f === undefined) {
      f = new Intl.DateTimeFormat(locale, o);
      dates.set(key, f);
    }
    return f;
  };
  // Numbers and dates inside messages follow the format locale; plural and select rules follow
  // the message's language (English text under a French region still says "1 day").
  const formatters: Formatters = {
    getNumberFormat: (_l, o) => numberFormat(o as Intl.NumberFormatOptions | undefined),
    getDateTimeFormat: (_l, o) => dateFormat(o ?? {}),
    getPluralRules: (_l, o) => new Intl.PluralRules(messageLocale, o),
  };
  return {
    locale,
    messageLocale,
    dir,
    t(id, values) {
      let f = compiled.get(id);
      if (f === undefined) {
        const source = catalogue[id] ?? en[id];
        if (source === undefined) return id;
        f = new IntlMessageFormat(source, messageLocale, undefined, {
          ignoreTag: true,
          formatters,
        });
        compiled.set(id, f);
      }
      const out = f.format(values as Record<string, string | number | boolean | Date>);
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
