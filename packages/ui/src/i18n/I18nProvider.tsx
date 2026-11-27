import {
  createContext,
  Fragment,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isLocaleLoaded, loadLocale } from "./catalogues.ts";
import { activeI18n, createI18n, type I18n, setActiveI18n } from "./core.ts";
import { type DirectionSetting, resolveMessageLocale, runtimeLocale } from "./locale.ts";

const I18nContext = createContext<I18n | null>(null);

export interface I18nProviderProps {
  /** The format locale (already resolved: Settings override or the system's). */
  locale?: string;
  /** The text's language (`ui.language`): "system" follows the format locale's catalogue. */
  language?: string;
  direction?: DirectionSetting;
  /** Sets `lang` and `dir` on `<html>` (the app root; off for stories and nested previews). */
  applyToDocument?: boolean;
  children?: ReactNode;
}

/**
 * Makes `locale` the active i18n for everything inside (and for `t()` in helpers). A change of
 * language, locale or direction remounts the subtree so every string and format updates at once;
 * it is a rare, deliberate change in onboarding or Settings.
 *
 * A language's catalogue loads on demand (`loadLocale`). When the requested one is not in memory
 * yet, the provider keeps rendering the language it had and switches once the load settles; if the
 * chunk fails to load it shows English rather than breaking.
 */
export function I18nProvider({
  locale,
  language,
  direction = "auto",
  applyToDocument = false,
  children,
}: I18nProviderProps): ReactElement {
  const requested = resolveMessageLocale(language ?? "system", locale ?? runtimeLocale());
  const ready = isLocaleLoaded(requested);
  const [, settle] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  // The last language that was in memory: what keeps showing while the next one loads.
  const shown = useRef(requested);
  if (ready) shown.current = requested;
  useEffect(() => {
    if (ready) return;
    let live = true;
    void loadLocale(requested).then((ok) => {
      if (!live) return;
      if (!ok) setFailed(requested);
      settle((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [requested, ready]);
  const effective = ready ? requested : failed === requested ? "en" : shown.current;
  const i18n = useMemo(
    () =>
      createI18n({
        ...(locale ? { locale } : {}),
        // The first render before any load settles reads the catalogue that is in memory.
        language: isLocaleLoaded(effective) ? effective : "en",
        direction,
      }),
    [locale, effective, direction],
  );
  // Set during render so the children's first render already reads this locale.
  if (activeI18n() !== i18n) setActiveI18n(i18n);
  useEffect(() => {
    setActiveI18n(i18n);
    if (!applyToDocument || typeof document === "undefined") return;
    const root = document.documentElement;
    root.lang = i18n.messageLocale;
    root.dir = i18n.dir;
  }, [i18n, applyToDocument]);
  return (
    <I18nContext.Provider value={i18n}>
      <Fragment key={`${i18n.messageLocale}/${i18n.locale}/${i18n.dir}`}>{children}</Fragment>
    </I18nContext.Provider>
  );
}

/** The i18n in effect here (the provider's, else the active one). */
export function useI18n(): I18n {
  return useContext(I18nContext) ?? activeI18n();
}
