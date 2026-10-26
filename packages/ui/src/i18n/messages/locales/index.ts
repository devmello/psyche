import { type Catalogue, en } from "../index.ts";
import { ar } from "./ar.ts";
import { de } from "./de.ts";
import { es } from "./es.ts";
import { fr } from "./fr.ts";
import { hi } from "./hi.ts";
import { it } from "./it.ts";
import { ja } from "./ja.ts";
import { ko } from "./ko.ts";
import { pt } from "./pt.ts";
import { zh } from "./zh.ts";

/**
 * The shipped catalogues, by message locale (a BCP 47 language subtag: "es", "pt", "zh"). English
 * is first and complete; every other catalogue lives in `./<lang>.ts` as
 * `export const <lang>: Partial<Catalogue>` with the same ids as `en`, and is listed here. An id a
 * catalogue leaves out falls back to English, per id. docs/guides/translating.md has the steps.
 */
const REGISTRY = {
  en,
  ar,
  de,
  es,
  fr,
  hi,
  it,
  ja,
  ko,
  pt,
  zh,
} satisfies Record<string, Partial<Catalogue>>;

export type MessageLocale = keyof typeof REGISTRY;

export const CATALOGUES: Readonly<Record<MessageLocale, Partial<Catalogue>>> = REGISTRY;

/** The languages offered in onboarding and Settings, English first. */
export const MESSAGE_LOCALES = Object.keys(CATALOGUES) as readonly MessageLocale[];
