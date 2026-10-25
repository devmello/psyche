/**
 * Native sidebar vibrancy (docs/design/redesign-2026.md §3.4, §4): the `appearance.vibrancy`
 * setting turns the macOS `sidebar` material on behind the main and Settings windows. The app
 * view's background then goes transparent and the renderer paints only its content column (the
 * sidebar shows the material; `data-vibrancy` in the kit). Off, the window and view paint the
 * opaque canvas colour.
 *
 * Off by default: Electron has no Liquid Glass and `setVibrancy` was reported to render flat
 * grey on macOS 26 (research/apple-and-reference-apps.md §2.2), and this build could not be
 * checked on a macOS 26 machine. The owner turns it on in Settings → Appearance.
 */

export const VIBRANCY_KEY = "appearance.vibrancy";

export interface VibrancyTarget {
  win: {
    setVibrancy(type: "sidebar" | null): void;
    setBackgroundColor(color: string): void;
    isDestroyed(): boolean;
  };
  view: { setBackgroundColor(color: string): void };
}

export interface VibrancyControllerOptions {
  /** The windows with chrome (main, Settings). */
  targets: () => VibrancyTarget[];
  /** A Gateway call; rejects while unpaired. */
  call: (method: string, params: unknown) => Promise<unknown>;
  /** The opaque canvas colour for the current appearance. */
  canvas: () => string;
  /** Vibrancy is a macOS material; elsewhere the setting is ignored. */
  supported: boolean;
  /**
   * macOS Reduce Transparency or Increase Contrast is on (`nativeTheme`): the native layer goes
   * opaque too, since the CSS media queries can't reach it (research/liquid-glass.md §6.3 item 3).
   */
  blocked?: () => boolean;
  warn?: (message: string) => void;
}

const TRANSPARENT = "#00000000";

export class VibrancyController {
  #on = false;
  readonly #o: VibrancyControllerOptions;

  constructor(options: VibrancyControllerOptions) {
    this.#o = options;
  }

  /** Whether the material is on (setting on and the platform supports it). */
  get on(): boolean {
    return this.#on && this.#o.supported && !(this.#o.blocked?.() ?? false);
  }

  apply(on: boolean): void {
    this.#on = on;
    for (const t of this.#o.targets()) this.applyTo(t);
  }

  /** Re-applies the current state (the system appearance changed the canvas colour). */
  refresh(): void {
    this.apply(this.#on);
  }

  /** A new window (or an appearance change) gets the current state. */
  applyTo(t: VibrancyTarget): void {
    if (t.win.isDestroyed()) return;
    if (this.on) {
      t.win.setVibrancy("sidebar");
      t.win.setBackgroundColor(TRANSPARENT);
      t.view.setBackgroundColor(TRANSPARENT);
    } else {
      if (this.#o.supported) t.win.setVibrancy(null);
      const canvas = this.#o.canvas();
      t.win.setBackgroundColor(canvas);
      t.view.setBackgroundColor(canvas);
    }
  }

  /** Reads the stored setting once paired; an unset key means off. */
  async load(): Promise<void> {
    try {
      const res = (await this.#o.call("settings.get", { keys: [VIBRANCY_KEY] })) as {
        settings?: Record<string, unknown>;
      };
      this.apply(res.settings?.[VIBRANCY_KEY] === true);
    } catch (err) {
      this.#o.warn?.(`could not read ${VIBRANCY_KEY}: ${String(err)}`);
    }
  }

  onSettingsChanged(entries: readonly { key: string; value: unknown }[]): void {
    const entry = entries.find((e) => e.key === VIBRANCY_KEY);
    if (entry) this.apply(entry.value === true);
  }
}
