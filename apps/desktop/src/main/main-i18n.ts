import { createI18n, createLoadedI18n, type MessageId } from "@psyche/ui/i18n-core";
import { systemLocale } from "./tray.ts";

/** The main process's words: a message id in the owner's language, with values. */
export type MainWords = (id: MessageId, values?: Record<string, string | number>) => string;

let loading: Promise<void> | undefined;

/**
 * Loads the system language's catalogue into the main process, once. The tray, the app menu and the
 * native dialogs all read through `createI18n`, which sees only catalogues already loaded (since the
 * lazy-locale change, #1765, the process loads just the one language). The app calls this first in
 * its startup, before it builds the tray or the menu. A chunk that fails to load leaves English.
 */
export function loadMainLocale(locale: string = systemLocale()): Promise<void> {
  loading ??= createLoadedI18n({ locale }).then(
    () => undefined,
    () => undefined,
  );
  return loading;
}

/** The main process's words in the system language (English until its catalogue is loaded). */
export function mainWords(locale: string = systemLocale()): MainWords {
  const i18n = createI18n({ locale });
  return (id, values) => i18n.t(id, values);
}

/** Loads the system language, then returns its words (for the native dialogs). */
export async function loadMainWords(): Promise<MainWords> {
  await loadMainLocale();
  return mainWords();
}
