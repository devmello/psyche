import { createContext, type ReactElement, type ReactNode, useContext } from "react";
import { useSettings } from "../data/hooks.ts";
import { I18nProvider } from "../i18n/I18nProvider.tsx";
import {
  DIRECTION_SETTING,
  type DirectionSetting,
  LOCALE_SETTING,
  resolveLocale,
} from "../i18n/locale.ts";
import { appearanceFromSettings, ThemeProvider } from "../theme/ThemeProvider.tsx";

const SystemLocale = createContext<string | null>(null);

/** The system's locale as the host reported it (Settings → Language and region shows it). */
export function useSystemLocale(): string | null {
  return useContext(SystemLocale);
}

export interface AppearanceProviderProps {
  /** The owner's macOS region format (desktop) or the browser's language (web). */
  systemLocale?: string | null;
  children?: ReactNode;
}

/**
 * The owner's Appearance settings applied to the window: `ThemeProvider` (theme, accent, gray,
 * density, contrast, reduce motion; docs/a11y-audit.md A2) and `I18nProvider` (the format
 * locale from `ui.locale` or the system, the direction from `ui.direction`; A12), fed from
 * `settings.get` and `settings.changed`. `lang` and `dir` are set on `<html>`.
 */
export function AppearanceProvider({
  systemLocale,
  children,
}: AppearanceProviderProps): ReactElement {
  const { settings } = useSettings();
  const direction = settings[DIRECTION_SETTING];
  return (
    <ThemeProvider settings={appearanceFromSettings(settings)}>
      <SystemLocale.Provider value={systemLocale ?? null}>
        <I18nProvider
          locale={resolveLocale(settings[LOCALE_SETTING] ?? "system", systemLocale)}
          direction={
            direction === "ltr" || direction === "rtl" ? (direction as DirectionSetting) : "auto"
          }
          applyToDocument
        >
          {children}
        </I18nProvider>
      </SystemLocale.Provider>
    </ThemeProvider>
  );
}
