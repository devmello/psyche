import { createContext, type ReactElement, type ReactNode, useContext, useEffect } from "react";
import { useSettings } from "../data/hooks.ts";
import { I18nProvider } from "../i18n/I18nProvider.tsx";
import {
  DIRECTION_SETTING,
  type DirectionSetting,
  LOCALE_SETTING,
  resolveLocale,
} from "../i18n/locale.ts";
import { fpsProbeEnabled, startFpsProbe } from "../motion/fps-probe.ts";
import { appearanceFromSettings, ThemeProvider } from "../theme/ThemeProvider.tsx";

/** Native sidebar vibrancy (desktop; docs/design/redesign-2026.md §3.4). */
export const VIBRANCY_SETTING = "appearance.vibrancy";
/** Opaque materials, like macOS Reduce transparency (redesign §3.4, §8). */
export const REDUCE_TRANSPARENCY_SETTING = "appearance.reduceTransparency";

const SystemLocale = createContext<string | null>(null);
const SupportsVibrancy = createContext(false);

/** The host can draw the native sidebar material (Settings → Appearance shows the vibrancy switch). */
export function useSupportsVibrancy(): boolean {
  return useContext(SupportsVibrancy);
}

/** The system's locale as the host reported it (Settings → Language and region shows it). */
export function useSystemLocale(): string | null {
  return useContext(SystemLocale);
}

export interface AppearanceProviderProps {
  /** The owner's macOS region format (desktop) or the browser's language (web). */
  systemLocale?: string | null;
  /** The host can draw the native sidebar material (the macOS desktop window). */
  supportsVibrancy?: boolean;
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
  supportsVibrancy = false,
  children,
}: AppearanceProviderProps): ReactElement {
  const { settings } = useSettings();
  const direction = settings[DIRECTION_SETTING];
  const vibrancy = supportsVibrancy && settings[VIBRANCY_SETTING] === true;
  const reduceTransparency = settings[REDUCE_TRANSPARENCY_SETTING];
  useWindowAttributes(vibrancy, reduceTransparency);
  return (
    <ThemeProvider settings={appearanceFromSettings(settings)}>
      <SystemLocale.Provider value={systemLocale ?? null}>
        <SupportsVibrancy.Provider value={supportsVibrancy}>
          <I18nProvider
            locale={resolveLocale(settings[LOCALE_SETTING] ?? "system", systemLocale)}
            direction={
              direction === "ltr" || direction === "rtl" ? (direction as DirectionSetting) : "auto"
            }
            applyToDocument
          >
            {children}
          </I18nProvider>
        </SupportsVibrancy.Provider>
      </SystemLocale.Provider>
    </ThemeProvider>
  );
}

/**
 * Root attributes the redesign tokens read (styles/design.css): `data-vibrancy` (the sidebar is
 * transparent over the native material), `data-reduce-transparency` (`true`, `false`, or absent
 * to follow the OS) and `data-window-active` (an inactive window loses the accent on its
 * selection, as macOS does).
 */
function useWindowAttributes(vibrancy: boolean, reduceTransparency: unknown): void {
  useEffect(() => {
    const root = typeof document === "undefined" ? null : document.documentElement;
    if (root === null) return;
    root.dataset.vibrancy = String(vibrancy);
    if (reduceTransparency === true || reduceTransparency === false)
      root.dataset.reduceTransparency = String(reduceTransparency);
    else delete root.dataset.reduceTransparency;
  }, [vibrancy, reduceTransparency]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    const set = () => {
      root.dataset.windowActive = String(document.hasFocus());
    };
    set();
    window.addEventListener("focus", set);
    window.addEventListener("blur", set);
    return () => {
      window.removeEventListener("focus", set);
      window.removeEventListener("blur", set);
    };
  }, []);

  useEffect(() => (fpsProbeEnabled() ? startFpsProbe() : undefined), []);
}
