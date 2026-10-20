import {
  createContext,
  Fragment,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
} from "react";
import { activeI18n, createI18n, type I18n, setActiveI18n } from "./core.ts";
import type { DirectionSetting } from "./locale.ts";

const I18nContext = createContext<I18n | null>(null);

export interface I18nProviderProps {
  /** The format locale (already resolved: Settings override or the system's). */
  locale?: string;
  direction?: DirectionSetting;
  /** Sets `lang` and `dir` on `<html>` (the app root; off for stories and nested previews). */
  applyToDocument?: boolean;
  children?: ReactNode;
}

/**
 * Makes `locale` the active i18n for everything inside (and for `t()` in helpers). A change of
 * locale or direction remounts the subtree so every string and format updates at once; it is a
 * rare, deliberate change in Settings.
 */
export function I18nProvider({
  locale,
  direction = "auto",
  applyToDocument = false,
  children,
}: I18nProviderProps): ReactElement {
  const i18n = useMemo(
    () => createI18n({ ...(locale ? { locale } : {}), direction }),
    [locale, direction],
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
      <Fragment key={`${i18n.locale}/${i18n.dir}`}>{children}</Fragment>
    </I18nContext.Provider>
  );
}

/** The i18n in effect here (the provider's, else the active one). */
export function useI18n(): I18n {
  return useContext(I18nContext) ?? activeI18n();
}
