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
export const CANVAS_COLOR = { light: "#fcfcfe", dark: "#111112" } as const;

export function canvasColor(dark: boolean): string {
  return dark ? CANVAS_COLOR.dark : CANVAS_COLOR.light;
}

/** Shared by the main and Settings windows: hidden title bar, lights on the sidebar. */
function chromeOptions(dark: boolean): BaseWindowConstructorOptions {
  return {
    titleBarStyle: "hidden",
    trafficLightPosition: { ...TRAFFIC_LIGHTS },
    backgroundColor: canvasColor(dark),
  };
}

export function mainWindowOptions(
  o: {
    /**
     * Let the window be sized past the screen (macOS clamps it to the visible area otherwise).
     * Only the layout e2e asks for it: CI's display is too small for 1440x900 (#561).
     */
    anySize?: boolean;
    /** The system appearance at creation (`nativeTheme.shouldUseDarkColors`). */
    dark?: boolean;
  } = {},
): BaseWindowConstructorOptions {
  return {
    ...MAIN_WINDOW_SIZE,
    minWidth: 900,
    minHeight: 600,
    title: "Psyche",
    show: false,
    ...chromeOptions(o.dark === true),
    ...(o.anySize ? { enableLargerThanScreen: true } : {}),
  };
}

/**
 * The Settings window (⌘,): its own window, as macOS settings are (redesign §4, §5.8), with the
 * main window's chrome (hidden title bar, the lights at the same place in the 52 px toolbar).
 * Where it opens is `window-placement.ts` (#596).
 */
export function settingsWindowOptions(o: { dark?: boolean } = {}): BaseWindowConstructorOptions {
  return {
    ...SETTINGS_WINDOW_SIZE,
    minWidth: SETTINGS_WINDOW_MIN.width,
    minHeight: SETTINGS_WINDOW_MIN.height,
    title: "Settings",
    show: false,
    fullscreenable: false,
    ...chromeOptions(o.dark === true),
  };
}

/** `PSYCHE_E2E_ANY_WINDOW_SIZE=1` on an unpackaged run (the e2e launches the app directory). */
export function wantsAnyWindowSize(packaged: boolean, env: NodeJS.ProcessEnv): boolean {
  return !packaged && env.PSYCHE_E2E_ANY_WINDOW_SIZE === "1";
}
