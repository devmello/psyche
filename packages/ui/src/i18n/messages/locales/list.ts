/**
 * The shipped message locales, English first. Light on purpose (no catalogue is imported here), so
 * the language pickers and `resolveMessageLocale` can know the list without loading any text. A new
 * language is added here, in `./index.ts` (the full registry the checks read) and in `LOADERS` of
 * `../../catalogues.ts` (the per-language chunk the app loads); a test keeps the three in step.
 */
export const MESSAGE_LOCALES = [
  "en",
  "ar",
  "de",
  "es",
  "fr",
  "hi",
  "it",
  "ja",
  "ko",
  "pt",
  "zh",
] as const;

export type MessageLocale = (typeof MESSAGE_LOCALES)[number];
