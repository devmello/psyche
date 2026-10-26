/**
 * The native side of the app's theme (#597): `appearance.theme` drives `nativeTheme.themeSource`,
 * so the window background, the traffic lights, menus and native dialogs match the renderer
 * instead of the macOS appearance (a Light app on a Dark Mac painted dark chrome). The chrome
 * windows (main, Settings) and their views then repaint the opaque canvas colour.
 *
 * Native sidebar vibrancy was tried here and dropped (#597): over a transparent WebContentsView,
 * Chromium's GPU compositor leaves translucent paints uncleared between frames (the selection
 * pill stacks to solid accent and leaves trails, which reads as flicker; electron/electron#42336
 * is the same class of bug). Only software compositing fixed it. The sidebar stays opaque.
 */

export const THEME_KEY = "appearance.theme";

export type ThemeSource = "system" | "light" | "dark";

export interface ChromeTarget {
  win: { setBackgroundColor(color: string): void; isDestroyed(): boolean };
  view: { setBackgroundColor(color: string): void };
}

export interface WindowThemeOptions {
  /** The windows with chrome (main, Settings). */
  targets: () => ChromeTarget[];
  /** A Gateway call; rejects while unpaired. */
  call: (method: string, params: unknown) => Promise<unknown>;
  /** Sets `nativeTheme.themeSource`. */
  setThemeSource: (source: ThemeSource) => void;
  /** The opaque canvas colour for the current (native) appearance. */
  canvas: () => string;
  warn?: (message: string) => void;
}

/** The setting's value as a theme source; "auto" and anything unknown follow the system. */
export function themeSource(value: unknown): ThemeSource {
  return value === "light" || value === "dark" ? value : "system";
}

export class WindowTheme {
  readonly #o: WindowThemeOptions;

  constructor(options: WindowThemeOptions) {
    this.#o = options;
  }

  /** Applies a stored theme value; `nativeTheme` fires "updated", which calls `refresh`. */
  apply(value: unknown): void {
    this.#o.setThemeSource(themeSource(value));
    this.refresh();
  }

  /** Repaints every chrome window in the canvas colour (the appearance changed). */
  refresh(): void {
    for (const t of this.#o.targets()) this.applyTo(t);
  }

  applyTo(t: ChromeTarget): void {
    if (t.win.isDestroyed()) return;
    const canvas = this.#o.canvas();
    t.win.setBackgroundColor(canvas);
    t.view.setBackgroundColor(canvas);
  }

  /** Reads the stored setting once paired; unset follows the system. */
  async load(): Promise<void> {
    try {
      const res = (await this.#o.call("settings.get", { keys: [THEME_KEY] })) as {
        settings?: Record<string, unknown>;
      };
      this.apply(res.settings?.[THEME_KEY]);
    } catch (err) {
      this.#o.warn?.(`could not read ${THEME_KEY}: ${String(err)}`);
    }
  }

  onSettingsChanged(entries: readonly { key: string; value: unknown }[]): void {
    const entry = entries.find((e) => e.key === THEME_KEY);
    if (entry) this.apply(entry.value);
  }
}
