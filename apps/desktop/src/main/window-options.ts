import { release as osRelease } from "node:os";
import type { BaseWindowConstructorOptions } from "electron";

/**
 * Window constructor options (no Electron import, so unit tests can read them). The main
 * window opens at the normal app size; the startup splash (#539) is a centred overlay inside
 * it, never a window of its own size.
 *
 * Window chrome (docs/design/redesign-2026.md §4): a hidden title bar whose traffic lights sit
 * on the sidebar, vertically centred in the 52 px unified toolbar row (`TITLEBAR_HEIGHT` in the
 * web shell); an opaque background in the canvas colour so nothing flashes white before the
 * first paint (the native theme follows `appearance.theme`, lib/window-theme.ts). No native
 * vibrancy: it flickered over the transparent view (#597).
 */

/** Where the traffic lights sit (window points), centred in the 52 px toolbar row. */
export const TRAFFIC_LIGHTS = { x: 20, y: 19 } as const;

export const MAIN_WINDOW_SIZE = { width: 1280, height: 860 } as const;
export const SETTINGS_WINDOW_SIZE = { width: 920, height: 640 } as const;
export const SETTINGS_WINDOW_MIN = { width: 760, height: 520 } as const;

/**
 * The canvas colour (`--canvas`, gray-1 of the default theme) per appearance. Native windows
 * paint it before the renderer has loaded; Electron recommends a background that matches the
 * app so the window "feels more native".
 */
export const CANVAS_COLOR = { light: "#fcfcfb", dark: "#111110" } as const;

export function canvasColor(dark: boolean): string {
  return dark ? CANVAS_COLOR.dark : CANVAS_COLOR.light;
}

/**
 * Windows (the counterpart of the inset title bar): the title bar is hidden and Windows draws its
 * own caption buttons (minimize, maximize, close, snap layouts) in a Window Controls Overlay on
 * the right, `TITLE_BAR_OVERLAY_HEIGHT` px tall. The renderer lays its toolbar out with
 * `env(titlebar-area-x/y/width/height)` and drags by it (`-webkit-app-region: drag`). The overlay
 * has no fill of its own, so the window's Mica (Windows 11 22H2+) or the renderer's canvas shows
 * under the buttons; the glyphs follow the theme (`titleBarOverlayColors`).
 */
export const TITLE_BAR_OVERLAY_HEIGHT = 40;

/** Glyph colours of the caption buttons on the canvas, per appearance (gray-12 of the theme). */
export const CAPTION_SYMBOL_COLOR = { light: "#1d1d1b", dark: "#ededec" } as const;

/** No fill (the material or the canvas shows through); in high contrast, the system's colours. */
export function titleBarOverlayColors(
  dark: boolean,
  highContrast = false,
): { color: string; symbolColor: string } {
  if (highContrast) {
    return dark
      ? { color: "#000000", symbolColor: "#ffffff" }
      : { color: "#ffffff", symbolColor: "#000000" };
  }
  return {
    color: "#00000000",
    symbolColor: dark ? CAPTION_SYMBOL_COLOR.dark : CAPTION_SYMBOL_COLOR.light,
  };
}

/** The system material behind Windows chrome windows; `none` in high contrast. */
export type WindowMaterial = "mica" | "acrylic" | "none";

/**
 * Whether Windows draws a system backdrop for this app: `DWMWA_SYSTEMBACKDROP_TYPE`, which
 * Electron's `backgroundMaterial` sets, exists from Windows 11 22H2 (build 22621). `release` is
 * `os.release()`, "10.0.<build>".
 */
export function backdropSupported(release: string = osRelease()): boolean {
  const build = Number(/^10\.0\.(\d+)/.exec(release)?.[1] ?? 0);
  return build >= 22621;
}

/**
 * Mica on Windows 11 22H2+ unless a contrast theme asks for solid colours; `none` on Windows 10,
 * where everything stays opaque.
 */
export function windowMaterial(
  platform: NodeJS.Platform,
  highContrast = false,
  release: string = osRelease(),
): WindowMaterial {
  return platform === "win32" && !highContrast && backdropSupported(release) ? "mica" : "none";
}

/**
 * A chrome window's background and its app view's: transparent over Mica (DWM draws the material
 * only where both let it through), so it shows wherever the page paints nothing
 * (`:root[data-material="mica"]`) and before its first paint; else the canvas colour.
 */
export function chromeViewBackground(
  platform: NodeJS.Platform,
  dark: boolean,
  highContrast = false,
  release: string = osRelease(),
): string {
  return windowMaterial(platform, highContrast, release) === "none"
    ? canvasColor(dark)
    : "#00000000";
}

/** Shared by the main and Settings windows: hidden title bar, lights on the sidebar. */
function chromeOptions(
  dark: boolean,
  platform: NodeJS.Platform,
  highContrast: boolean,
  release: string = osRelease(),
): BaseWindowConstructorOptions {
  if (platform === "win32") {
    const material = windowMaterial(platform, highContrast, release);
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: {
        ...titleBarOverlayColors(dark, highContrast),
        height: TITLE_BAR_OVERLAY_HEIGHT,
      },
      backgroundColor: chromeViewBackground(platform, dark, highContrast, release),
      ...(material === "none" ? {} : { backgroundMaterial: material }),
    };
  }
  return {
    titleBarStyle: "hidden",
    trafficLightPosition: { ...TRAFFIC_LIGHTS },
    backgroundColor: canvasColor(dark),
  };
}

export interface ChromeWindowOptionsInput {
  /** The system appearance at creation (`nativeTheme.shouldUseDarkColors`). */
  dark?: boolean;
  /** `nativeTheme.shouldUseHighContrastColors` (Windows contrast themes). */
  highContrast?: boolean;
  /** Default `process.platform`. */
  platform?: NodeJS.Platform;
  /** `os.release()` (tests): Windows 11 22H2+ draws Mica and acrylic. */
  release?: string;
}

export function mainWindowOptions(
  o: ChromeWindowOptionsInput & {
    /**
     * Let the window be sized past the screen (macOS clamps it to the visible area otherwise).
     * Only the layout e2e asks for it: CI's display is too small for 1440x900 (#561).
     */
    anySize?: boolean;
  } = {},
): BaseWindowConstructorOptions {
  return {
    ...MAIN_WINDOW_SIZE,
    minWidth: 900,
    minHeight: 600,
    title: "Psyche",
    show: false,
    ...chromeOptions(
      o.dark === true,
      o.platform ?? process.platform,
      o.highContrast === true,
      o.release,
    ),
    ...(o.anySize ? { enableLargerThanScreen: true } : {}),
  };
}

/**
 * The Settings window (⌘,): its own window, as macOS settings are (redesign §4, §5.8), with the
 * main window's chrome (hidden title bar, the lights at the same place in the 52 px toolbar).
 * Where it opens is `window-placement.ts` (#596).
 */
export function settingsWindowOptions(
  o: ChromeWindowOptionsInput = {},
): BaseWindowConstructorOptions {
  return {
    ...SETTINGS_WINDOW_SIZE,
    minWidth: SETTINGS_WINDOW_MIN.width,
    minHeight: SETTINGS_WINDOW_MIN.height,
    title: "Settings",
    show: false,
    fullscreenable: false,
    ...chromeOptions(
      o.dark === true,
      o.platform ?? process.platform,
      o.highContrast === true,
      o.release,
    ),
  };
}

export const QUICK_ENTRY_SIZE = { width: 640, height: 160 } as const;

/**
 * The quick-entry bar (pop-up chat): frameless, always on top, out of the taskbar and the app
 * switcher. On Windows 11 DWM rounds and shadows it (`roundedCorners`, the default) and an
 * acrylic material sits behind the renderer, like the system's own flyouts.
 */
export function quickEntryWindowOptions(
  o: ChromeWindowOptionsInput = {},
): BaseWindowConstructorOptions {
  const platform = o.platform ?? process.platform;
  return {
    ...QUICK_ENTRY_SIZE,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    title: "Quick entry",
    ...(platform === "win32"
      ? {
          roundedCorners: true,
          maximizable: false,
          minimizable: false,
          fullscreenable: false,
          backgroundColor: canvasColor(o.dark === true),
          ...(o.highContrast === true || !backdropSupported(o.release)
            ? {}
            : { backgroundMaterial: "acrylic" as const }),
        }
      : {}),
  };
}

/** `PSYCHE_E2E_ANY_WINDOW_SIZE=1` on an unpackaged run (the e2e launches the app directory). */
export function wantsAnyWindowSize(packaged: boolean, env: NodeJS.ProcessEnv): boolean {
  return !packaged && env.PSYCHE_E2E_ANY_WINDOW_SIZE === "1";
}
