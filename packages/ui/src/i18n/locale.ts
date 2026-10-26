import { MESSAGE_LOCALES, type MessageLocale } from "./messages/locales/index.ts";

export { MESSAGE_LOCALES, type MessageLocale };

/**
 * Locales (A12). Two are in play:
 *
 * - the **format locale**: how numbers, dates and times are written. It is the owner's macOS
 *   region format (`app.getSystemLocale()` on the desktop, the browser's language on the web),
 *   unless Settings → Appearance → Language and region (`ui.locale`) overrides it;
 * - the **message locale**: which catalogue the text comes from: the owner's choice in onboarding
 *   or Settings (`ui.language`), else the best shipped catalogue for the format locale.
 *
 * The text direction follows the message locale unless `ui.direction` overrides it, so
 * translators can check a right-to-left layout before their catalogue exists.
 */

export const LOCALE_SETTING = "ui.locale";
export const DIRECTION_SETTING = "ui.direction";
/** The text's language: "system" (the default) or a shipped message locale. */
export const LANGUAGE_SETTING = "ui.language";

export type Direction = "ltr" | "rtl";
export type DirectionSetting = "auto" | Direction;

const RTL_LANGUAGES = new Set(["ar", "dv", "fa", "he", "iw", "ku", "ps", "sd", "ug", "ur", "yi"]);

/** A valid BCP 47 tag in canonical form, or null. */
export function canonicalLocale(tag: unknown): string | null {
  if (typeof tag !== "string" || tag.trim() === "") return null;
  try {
    return Intl.getCanonicalLocales(tag.trim().replace(/_/g, "-"))[0] ?? null;
  } catch {
    return null;
  }
}

/** The runtime's default locale (the browser's or Electron's), "en-US" when unknown. */
export function runtimeLocale(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  } catch {
    return "en-US";
  }
}

/** The format locale: the Settings override when it is a valid tag, else the system's. */
export function resolveLocale(setting: unknown, system: string | null | undefined): string {
  if (setting !== "system") {
    const chosen = canonicalLocale(setting);
    if (chosen) return chosen;
  }
  return canonicalLocale(system) ?? runtimeLocale();
}

const language = (locale: string) => locale.split("-")[0]?.toLowerCase() ?? "en";

const isMessageLocale = (lang: string): lang is MessageLocale =>
  (MESSAGE_LOCALES as readonly string[]).includes(lang);

/** The best shipped catalogue for a locale: its language when one exists, else English. */
export function messageLocaleFor(locale: string): MessageLocale {
  const lang = language(locale);
  return isMessageLocale(lang) ? lang : "en";
}

/**
 * The text's language: `ui.language` when it names a shipped catalogue, else the best catalogue
 * for the format locale (a German region reads German once a German catalogue ships).
 */
export function resolveMessageLocale(setting: unknown, formatLocale: string): MessageLocale {
  if (typeof setting === "string" && setting !== "system") {
    const lang = language(canonicalLocale(setting) ?? setting);
    if (isMessageLocale(lang)) return lang;
  }
  return messageLocaleFor(formatLocale);
}

export function directionOf(locale: string): Direction {
  return RTL_LANGUAGES.has(language(locale)) ? "rtl" : "ltr";
}

/** The layout direction: the override, else the message locale's. */
export function resolveDirection(setting: unknown, messageLocale: string): Direction {
  return setting === "rtl" || setting === "ltr" ? setting : directionOf(messageLocale);
}

/** Format locales offered in Settings, besides "System" (any valid tag also works). */
export const OFFERED_LOCALES = [
  "en-US",
  "en-GB",
  "en-AU",
  "en-CA",
  "en-IN",
  "de-DE",
  "es-ES",
  "es-MX",
  "fr-FR",
  "fr-CA",
  "it-IT",
  "nl-NL",
  "pt-BR",
  "pt-PT",
  "sv-SE",
  "pl-PL",
  "tr-TR",
  "ru-RU",
  "uk-UA",
  "ar-EG",
  "he-IL",
  "hi-IN",
  "ja-JP",
  "ko-KR",
  "zh-CN",
  "zh-TW",
] as const;

/** Native names for the languages catalogues are planned for, when the runtime has no names. */
const NATIVE_NAMES: Readonly<Record<string, string>> = {
  // i18n-ignore-start: language names are written in their own language, not translated
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
  it: "Italiano",
  ja: "日本語",
  zh: "中文",
  ko: "한국어",
  hi: "हिन्दी",
  ar: "العربية",
  // i18n-ignore-end
};

/**
 * A language or locale's name in `displayLocale`: "English (United Kingdom)", or, with the same
 * tag twice, the native name the language pickers show ("Deutsch", "日本語"). Falls back to the
 * native-name table, then to the tag.
 */
export function localeName(tag: string, displayLocale: string): string {
  let name: string | undefined;
  try {
    name = new Intl.DisplayNames([displayLocale], { type: "language" }).of(tag);
  } catch {
    name = undefined;
  }
  if (name === undefined || name === tag) return NATIVE_NAMES[language(tag)] ?? tag;
  // Pickers list names as headings: "Español", not "español".
  return name.charAt(0).toLocaleUpperCase(displayLocale) + name.slice(1);
}
