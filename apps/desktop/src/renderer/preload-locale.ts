import { canonicalLocale, loadLocale, messageLocaleFor, runtimeLocale } from "@psyche/ui";
import { desktopPlatform } from "./bridge.ts";

/**
 * Loads the language this window will first read, before `createRoot`, so the first paint is in it
 * (no English flash) and the window holds English plus that one catalogue instead of all ten. It
 * is the system's language (the default `ui.language`); a different choice in Settings loads when
 * the setting arrives, and `I18nProvider` keeps the current text until that chunk is in.
 * Never throws: a failed load leaves English, which `t()` already falls back to.
 */
export async function loadFirstLocale(
  systemLocale: () => Promise<string | null | undefined> = async () =>
    (await desktopPlatform().locale?.get())?.system,
): Promise<void> {
  let system: string | null | undefined = globalThis.navigator?.language;
  try {
    system = (await systemLocale()) ?? system;
  } catch {
    // The main process did not answer: the browser's language is the best guess.
  }
  try {
    await loadLocale(messageLocaleFor(canonicalLocale(system) ?? runtimeLocale()));
  } catch {
    // English.
  }
}
