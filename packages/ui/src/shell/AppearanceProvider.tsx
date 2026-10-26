import { createContext, type ReactElement, type ReactNode, useContext, useEffect } from "react";
import { useSettings } from "../data/hooks.ts";
import { I18nProvider } from "../i18n/I18nProvider.tsx";
import {
  DIRECTION_SETTING,
  type DirectionSetting,
  LOCALE_SETTING,
  resolveLocale,
} from "../i18n/locale.ts";
import { glassCssVariables, glassPreset, glassValues } from "../lib/glass-settings.ts";
import { fpsProbeEnabled, startFpsProbe } from "../motion/fps-probe.ts";
import { appearanceFromSettings, ThemeProvider } from "../theme/ThemeProvider.tsx";

/** Opaque materials, like macOS Reduce transparency (redesign §3.4, §8). */
export const REDUCE_TRANSPARENCY_SETTING = "appearance.reduceTransparency";

const SystemLocale = createContext<string | null>(null);

/** The system's locale as the host reported it (Settings → Language and region shows it). */
export function useSystemLocale(): string | null {
  return useContext(SystemLocale);
}

export interface AppearanceProviderProps {
  /** The owner's macOS region format (desktop) or the browser's language (web). */
  systemLocale?: string | null;
  /**
   * macOS Reduce Transparency / Increase Contrast as the desktop main reads them
   * (`nativeTheme`); they apply when the owner hasn't chosen in Settings. The web relies on the
   * `prefers-reduced-transparency` / `prefers-contrast` media queries instead.
   */
  system?: { reduceTransparency: boolean; highContrast: boolean } | null;
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
  system = null,
  children,
}: AppearanceProviderProps): ReactElement {
  const { settings } = useSettings();
  const direction = settings[DIRECTION_SETTING];
  const chosenTransparency = settings[REDUCE_TRANSPARENCY_SETTING];
  const reduceTransparency =
    chosenTransparency === true || chosenTransparency === false
      ? chosenTransparency
      : system?.reduceTransparency
        ? true
        : undefined;
  useWindowAttributes(reduceTransparency);
  useGlassSettings(settings);
  const appearance = appearanceFromSettings(settings);
  // Increase Contrast from macOS applies until the owner picks a contrast in Settings.
  if (settings["appearance.contrast"] === undefined && system?.highContrast)
    appearance.contrast = "high";
  return (
    <ThemeProvider settings={appearance}>
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

/**
 * Root attributes the redesign tokens read (styles/design.css): `data-reduce-transparency`
 * (`true`, `false`, or absent to follow the OS) and `data-window-active` (an inactive window
 * loses the accent on its selection, as macOS does).
 */
function useWindowAttributes(reduceTransparency: unknown): void {
  useEffect(() => {
    const root = typeof document === "undefined" ? null : document.documentElement;
    if (root === null) return;
    if (reduceTransparency === true || reduceTransparency === false)
      root.dataset.reduceTransparency = String(reduceTransparency);
    else delete root.dataset.reduceTransparency;
  }, [reduceTransparency]);

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

/**
 * Settings → Appearance → Translucency (#597): the preset as `data-glass-preset` and the values as
 * root CSS variables the material tokens read (styles/design.css). Reduce Transparency, Increase
 * Contrast and an inactive window still override the result.
 */
function useGlassSettings(settings: Record<string, unknown>): void {
  const preset = glassPreset(settings);
  const vars = glassCssVariables(glassValues(settings));
  const key = JSON.stringify(vars);
  useEffect(() => {
    const root = typeof document === "undefined" ? null : document.documentElement;
    if (root === null) return;
    root.dataset.glassPreset = preset;
    const values = JSON.parse(key) as Record<string, string>;
    for (const [name, value] of Object.entries(values)) root.style.setProperty(name, value);
    return () => {
      for (const name of Object.keys(values)) root.style.removeProperty(name);
    };
  }, [preset, key]);
}
