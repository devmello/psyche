import { createI18n, createLoadedI18n, type MessageId } from "@psyche/ui/i18n-core";
import { systemLocale } from "./tray.ts";

/** The native dialogs' words: `desktop.dialog.*` in the owner's language (English when unknown). */
export type DialogWords = (id: MessageId, values?: Record<string, string | number>) => string;

const english = createI18n({ locale: "en" });
const englishWords: DialogWords = (id, values) => english.t(id, values);

let loaded: DialogWords | undefined;
let loading: Promise<DialogWords> | undefined;

/**
 * Loads the system language's catalogue (once) and returns its words. The tray and menu resolve the
 * language the same way (`systemLocale()`); `createI18n` reads only catalogues already in memory,
 * so the main process loads the chunk first. A chunk that fails to load leaves English.
 */
export function loadDialogWords(locale: string = systemLocale()): Promise<DialogWords> {
  loading ??= createLoadedI18n({ locale }).then(
    (i18n) => {
      loaded = (id, values) => i18n.t(id, values);
      return loaded;
    },
    () => {
      loaded = englishWords;
      return loaded;
    },
  );
  return loading;
}

/** The words once loaded; English until then (call `loadDialogWords` first where that matters). */
export function dialogWords(): DialogWords {
  return loaded ?? englishWords;
}
