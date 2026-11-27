import { type UiPlatform, uiPlatform } from "../lib/platform.ts";
import { type Catalogue, en } from "./messages/index.ts";
import type { MessageLocale } from "./messages/locales/list.ts";
import { hasPlatformVariants, registerPlatformVariants } from "./messages/variants/index.ts";

/**
 * The catalogues in memory. English is always there (it is the fallback for every id); another
 * language is added by `loadLocale`, one dynamic `import()` (one chunk) per language, so a window
 * parses English plus the language the owner reads and nothing else. `t()` stays synchronous: it
 * reads this store, and an id (or a whole language) that is not there yet reads English.
 */
const loaded = new Map<string, Partial<Catalogue>>([["en", en]]);

type Loader = () => Promise<Partial<Catalogue>>;

const LOADERS: Readonly<Record<Exclude<MessageLocale, "en">, Loader>> = {
  ar: () => import("./messages/locales/ar.ts").then((m) => m.ar),
  de: () => import("./messages/locales/de.ts").then((m) => m.de),
  es: () => import("./messages/locales/es.ts").then((m) => m.es),
  fr: () => import("./messages/locales/fr.ts").then((m) => m.fr),
  hi: () => import("./messages/locales/hi.ts").then((m) => m.hi),
  it: () => import("./messages/locales/it.ts").then((m) => m.it),
  ja: () => import("./messages/locales/ja.ts").then((m) => m.ja),
  ko: () => import("./messages/locales/ko.ts").then((m) => m.ko),
  pt: () => import("./messages/locales/pt.ts").then((m) => m.pt),
  zh: () => import("./messages/locales/zh.ts").then((m) => m.zh),
};

/** The language codes `loadLocale` can fetch (a test keeps this in step with the registry). */
export const LOADABLE_LOCALES: readonly string[] = ["en", ...Object.keys(LOADERS)];

/** The in-memory catalogue for a locale, or undefined while it has not been loaded. */
export function getCatalogue(locale: string): Partial<Catalogue> | undefined {
  return loaded.get(locale);
}

/** Adds a catalogue directly (the test setup registers every language). */
export function registerCatalogue(locale: string, catalogue: Partial<Catalogue>): void {
  loaded.set(locale, catalogue);
}

const needsVariants = (platform: UiPlatform) => platform === "windows" || platform === "linux";

/** Loads the Windows or Linux variant tables, only on that platform. */
async function loadVariants(platform: UiPlatform): Promise<void> {
  if (!needsVariants(platform) || hasPlatformVariants(platform)) return;
  if (platform === "windows") {
    const [base, locales] = await Promise.all([
      import("./messages/variants/windows.ts"),
      import("./messages/variants/windows-locales.ts"),
    ]);
    registerPlatformVariants("windows", base.windows, locales.WINDOWS_LOCALES);
  } else {
    const [base, locales] = await Promise.all([
      import("./messages/variants/linux.ts"),
      import("./messages/variants/linux-locales.ts"),
    ]);
    registerPlatformVariants("linux", base.linux, locales.LINUX_LOCALES);
  }
}

/** True when `locale`'s catalogue and this platform's variants are in memory. */
export function isLocaleLoaded(locale: string): boolean {
  const platform = uiPlatform();
  return loaded.has(locale) && (!needsVariants(platform) || hasPlatformVariants(platform));
}

const inflight = new Map<string, Promise<boolean>>();

/**
 * Loads `locale`'s catalogue (and, on Windows or Linux, that platform's variants). Resolves true
 * when everything is in memory and false when a chunk failed to load: nothing throws, and `t()`
 * keeps reading English for what is missing. A failed load can be retried by calling again.
 */
export function loadLocale(locale: string): Promise<boolean> {
  if (isLocaleLoaded(locale)) return Promise.resolve(true);
  const platform = uiPlatform();
  const key = `${locale}@${platform}`;
  let pending = inflight.get(key);
  if (pending === undefined) {
    const loader = (LOADERS as Readonly<Record<string, Loader | undefined>>)[locale];
    pending = (async () => {
      try {
        const [catalogue] = await Promise.all([
          loaded.has(locale) ? undefined : loader?.(),
          loadVariants(platform),
        ]);
        if (catalogue !== undefined) loaded.set(locale, catalogue);
        // An unknown language has nothing to load: it reads English, which is not a failure.
        return loaded.has(locale) || loader === undefined;
      } catch {
        return false;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, pending);
  }
  return pending;
}
