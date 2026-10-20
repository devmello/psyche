/**
 * Locales (A12). Two are in play:
 *
 * - the **format locale**: how numbers, dates and times are written. It is the owner's macOS
 *   region format (`app.getSystemLocale()` on the desktop, the browser's language on the web),
 *   unless Settings → Appearance → Language and region (`ui.locale`) overrides it;
 * - the **message locale**: which catalogue the text comes from, the best catalogue for the
 *   format locale. Only English ships, so it is "en" for now.
 *
 * The text direction follows the message locale unless `ui.direction` overrides it, so
 * translators can check a right-to-left layout before their catalogue exists.
 */

export const LOCALE_SETTING = "ui.locale";
export const DIRECTION_SETTING = "ui.direction";

/** Catalogues that ship (docs/guides/translating.md adds one). */
export const MESSAGE_LOCALES = ["en"] as const;
export type MessageLocale = (typeof MESSAGE_LOCALES)[number];

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

/** The best shipped catalogue for a locale: its language when one exists, else English. */
export function messageLocaleFor(locale: string): MessageLocale {
  const lang = language(locale);
  return (MESSAGE_LOCALES as readonly string[]).includes(lang) ? (lang as MessageLocale) : "en";
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

/** "English (United Kingdom)" in the display locale; the tag itself when names are missing. */
export function localeName(tag: string, displayLocale: string): string {
  try {
    return new Intl.DisplayNames([displayLocale], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}
