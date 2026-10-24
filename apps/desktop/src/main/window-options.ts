import type { BaseWindowConstructorOptions } from "electron";

/**
 * The main window's constructor options (no Electron import, so unit tests can read them). It
 * opens at the normal app size; the startup splash (#539) is a centred overlay inside it, never a
 * window of its own size.
 */

/**
 * The main window draws its own title bar (`hiddenInset`); the traffic lights sit at this
 * position, vertically centred in the shell's 52 px bar (`TITLEBAR_HEIGHT` in the web shell).
 */
export const TRAFFIC_LIGHTS = { x: 18, y: 19 } as const;

export const MAIN_WINDOW_SIZE = { width: 1280, height: 860 } as const;

export function mainWindowOptions(
  o: {
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
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { ...TRAFFIC_LIGHTS },
    ...(o.anySize ? { enableLargerThanScreen: true } : {}),
  };
}

/** `PSYCHE_E2E_ANY_WINDOW_SIZE=1` on an unpackaged run (the e2e launches the app directory). */
export function wantsAnyWindowSize(packaged: boolean, env: NodeJS.ProcessEnv): boolean {
  return !packaged && env.PSYCHE_E2E_ANY_WINDOW_SIZE === "1";
}
