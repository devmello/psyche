import { type Catalogue, en } from "../index.ts";

/**
 * The shipped catalogues, by message locale (a BCP 47 language subtag: "es", "pt", "zh"). English
 * is first and complete; every other catalogue lives in `./<lang>.ts` as
 * `export const <lang>: Partial<Catalogue>` with the same ids as `en`, and is listed here. An id a
 * catalogue leaves out falls back to English, per id. docs/guides/translating.md has the steps.
 */
const REGISTRY = {
  en,
} satisfies Record<string, Partial<Catalogue>>;

export type MessageLocale = keyof typeof REGISTRY;

export const CATALOGUES: Readonly<Record<MessageLocale, Partial<Catalogue>>> = REGISTRY;

/** The languages offered in onboarding and Settings, English first. */
export const MESSAGE_LOCALES = Object.keys(CATALOGUES) as readonly MessageLocale[];
