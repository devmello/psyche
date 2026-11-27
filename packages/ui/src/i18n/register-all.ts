import { registerCatalogue } from "./catalogues.ts";
import { CATALOGUES } from "./messages/locales/index.ts";
import { registerPlatformVariants } from "./messages/variants/index.ts";
import { linux } from "./messages/variants/linux.ts";
import { LINUX_LOCALES } from "./messages/variants/linux-locales.ts";
import { windows } from "./messages/variants/windows.ts";
import { WINDOWS_LOCALES } from "./messages/variants/windows-locales.ts";

/**
 * Puts every language and both platform variant tables in memory. For tests, stories and tools that
 * format in several languages or on several platforms synchronously; the app loads one language
 * at a time with `loadLocale` and never imports this file.
 */
export function registerAllCatalogues(): void {
  for (const [locale, catalogue] of Object.entries(CATALOGUES))
    registerCatalogue(locale, catalogue);
  registerPlatformVariants("windows", windows, WINDOWS_LOCALES);
  registerPlatformVariants("linux", linux, LINUX_LOCALES);
}

registerAllCatalogues();
