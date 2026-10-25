import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useInsertionEffect,
  useMemo,
  useState,
} from "react";
import { MotionProvider } from "../motion/MotionProvider.tsx";
import { THEME_STYLE_ID, themeToCss } from "./css.ts";
import {
  type Appearance,
  DEFAULT_ACCENT_SEED,
  type GeneratedTheme,
  type GrayFamily,
  generateTheme,
  isValidSeed,
} from "./generate.ts";

/**
 * `settings.appearance` (UI design §4.10). The Gateway stores it under `appearance.*` keys and
 * broadcasts `settings.changed`, so every paired client re-themes.
 */
export interface AppearanceSettings {
  theme: "auto" | Appearance;
  accentSeed: string;
  gray: GrayFamily;
  density: "comfortable" | "compact";
  /** `system` follows `prefers-reduced-motion`. */
  reduceMotion: boolean | "system";
  contrast: "standard" | "high";
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: "auto",
  accentSeed: DEFAULT_ACCENT_SEED,
  gray: "auto",
  density: "comfortable",
  reduceMotion: "system",
  contrast: "standard",
};

/** Reads `appearance.*` keys out of a flat settings map (`settings.get`), ignoring bad values. */
export function appearanceFromSettings(settings: Record<string, unknown>): AppearanceSettings {
  const out = { ...DEFAULT_APPEARANCE };
  const theme = settings["appearance.theme"];
  if (theme === "auto" || theme === "light" || theme === "dark") out.theme = theme;
  const seed = settings["appearance.accentSeed"];
  if (typeof seed === "string" && isValidSeed(seed)) out.accentSeed = seed;
  const gray = settings["appearance.gray"];
  if (
    typeof gray === "string" &&
    ["auto", "neutral", "slate", "mauve", "sage", "olive", "sand"].includes(gray)
  )
    out.gray = gray as GrayFamily;
  const density = settings["appearance.density"];
  if (density === "comfortable" || density === "compact") out.density = density;
  const motion = settings["appearance.reduceMotion"];
  if (typeof motion === "boolean" || motion === "system") out.reduceMotion = motion;
  const contrast = settings["appearance.contrast"];
  if (contrast === "standard" || contrast === "high") out.contrast = contrast;
  return out;
}

export interface ThemeContextValue {
  settings: AppearanceSettings;
  /** The appearance actually shown (auto resolved through `prefers-color-scheme`). */
  resolved: Appearance;
  reduceMotion: boolean;
  theme: GeneratedTheme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function useMedia(query: string, fallback: boolean): boolean {
  const get = () =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : fallback;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export interface ThemeProviderProps {
  settings?: Partial<AppearanceSettings>;
  children?: ReactNode;
  /**
   * Element that receives `data-theme`, `data-density`, `data-reduce-motion` and
   * `data-contrast`. Defaults to `document.documentElement`; stories pass their own root.
   */
  target?: HTMLElement | null;
}

/** Generates the scales, injects `<style id="psyche-theme">` and sets the root attributes. */
export function ThemeProvider({ settings, children, target }: ThemeProviderProps): ReactElement {
  const merged: AppearanceSettings = { ...DEFAULT_APPEARANCE, ...settings };
  const seed = isValidSeed(merged.accentSeed) ? merged.accentSeed : DEFAULT_ACCENT_SEED;
  const prefersDark = useMedia("(prefers-color-scheme: dark)", false);
  const prefersReduced = useMedia("(prefers-reduced-motion: reduce)", false);
  const resolved: Appearance =
    merged.theme === "auto" ? (prefersDark ? "dark" : "light") : merged.theme;
  const reduceMotion = merged.reduceMotion === "system" ? prefersReduced : merged.reduceMotion;

  const theme = useMemo(
    () => generateTheme({ accentSeed: seed, gray: merged.gray }),
    [seed, merged.gray],
  );
  const css = useMemo(() => themeToCss(theme), [theme]);

  useInsertionEffect(() => {
    if (typeof document === "undefined") return;
    let el = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null;
    if (el === null) {
      el = document.createElement("style");
      el.id = THEME_STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = css;
  }, [css]);

  useEffect(() => {
    const root = target ?? (typeof document === "undefined" ? null : document.documentElement);
    if (root === null) return;
    root.dataset.theme = resolved;
    root.dataset.density = merged.density;
    root.dataset.reduceMotion = String(reduceMotion);
    root.dataset.contrast = merged.contrast;
    root.style.colorScheme = resolved;
  }, [target, resolved, merged.density, reduceMotion, merged.contrast]);

  const { theme: themeSetting, gray, density, contrast, reduceMotion: motionSetting } = merged;
  const normalized = useMemo<AppearanceSettings>(
    () => ({
      theme: themeSetting,
      accentSeed: seed,
      gray,
      density,
      contrast,
      reduceMotion: motionSetting,
    }),
    [themeSetting, seed, gray, density, contrast, motionSetting],
  );
  const value = useMemo<ThemeContextValue>(
    () => ({ settings: normalized, resolved, reduceMotion, theme }),
    [normalized, resolved, reduceMotion, theme],
  );

  return (
    <ThemeContext.Provider value={value}>
      <MotionProvider reduce={reduceMotion}>{children}</MotionProvider>
    </ThemeContext.Provider>
  );
}

/** Theme state; outside a provider it reports the defaults without generating CSS. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  // Outside a provider, motion still follows the OS (docs/a11y-audit.md M5).
  const osReduced = useMedia("(prefers-reduced-motion: reduce)", false);
  const fallback = useMemo(
    () => (ctx === null ? generateTheme({ accentSeed: DEFAULT_ACCENT_SEED }) : null),
    [ctx],
  );
  if (ctx !== null) return ctx;
  return {
    settings: DEFAULT_APPEARANCE,
    resolved: "light",
    reduceMotion: osReduced,
    theme: fallback as GeneratedTheme,
  };
}

/** `true` when animation loops should render their static frame (UI design §4.5). */
export function useReducedMotion(): boolean {
  return useTheme().reduceMotion;
}
