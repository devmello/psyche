import { type Catalogue, en } from "../index.ts";
import { ar } from "./ar.ts";
import { de } from "./de.ts";
import { es } from "./es.ts";
import { fr } from "./fr.ts";
import { hi } from "./hi.ts";
import { it } from "./it.ts";
import { ja } from "./ja.ts";
import { ko } from "./ko.ts";
import { MESSAGE_LOCALES, type MessageLocale } from "./list.ts";
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

export { MESSAGE_LOCALES, type MessageLocale };

/**
 * Every catalogue at once. Only the checks (`pnpm i18n:check`), the tests and `register-all.ts`
 * import this file; the app never does, so a window holds English plus one language
 * (`../../catalogues.ts`).
 */
export const CATALOGUES: Readonly<Record<MessageLocale, Partial<Catalogue>>> = REGISTRY;
