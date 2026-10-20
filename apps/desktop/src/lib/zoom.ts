// The zoom module itself, not the `@psyche/web/compose` barrel: the barrel re-exports the viewers,
// which pulled ≈ 23 MB of renderer code into the main-process bundle.
import { clampZoom, ZOOM_DEFAULT, ZOOM_KEY, zoomFactor, zoomStep } from "@psyche/web/compose/zoom";

/**
 * Applies the `appearance.zoom` setting to every app renderer and persists the View menu's
 * changes through the Gateway (docs/06 §3.18 Appearance). Electron remembers a per-origin zoom
 * on its own; applying the stored setting on every load is what normalizes a stray ⌘+ from an
 * earlier session to what the user chose.
 */

export interface ZoomTarget {
  setZoomFactor(factor: number): void;
  isDestroyed(): boolean;
}

export interface ZoomControllerOptions {
  /** Every live app renderer. */
  targets: () => ZoomTarget[];
  /** A Gateway call; rejects while unpaired, which only skips persistence. */
  call: (method: string, params: unknown) => Promise<unknown>;
  warn?: (message: string) => void;
}

export class ZoomController {
  #percent = ZOOM_DEFAULT;
  readonly #o: ZoomControllerOptions;

  constructor(options: ZoomControllerOptions) {
    this.#o = options;
  }

  get percent(): number {
    return this.#percent;
  }

  /** Applies a percentage to every renderer without persisting it. */
  apply(percent: number): void {
    this.#percent = clampZoom(percent);
    for (const t of this.#o.targets()) this.applyTo(t);
  }

  /** A renderer that just loaded gets the current zoom (Electron would restore its own). */
  applyTo(target: ZoomTarget): void {
    if (target.isDestroyed()) return;
    target.setZoomFactor(zoomFactor(this.#percent));
  }

  /** Reads the stored setting once paired; an unset key means the default. */
  async load(): Promise<void> {
    try {
      const res = (await this.#o.call("settings.get", { keys: [ZOOM_KEY] })) as {
        settings?: Record<string, unknown>;
      };
      this.apply(clampZoom(res.settings?.[ZOOM_KEY]));
    } catch (err) {
      this.#o.warn?.(`could not read ${ZOOM_KEY}: ${String(err)}`);
    }
  }

  /** Applies at once and stores the value; a failed store keeps the zoom for this session. */
  async set(percent: number): Promise<void> {
    this.apply(percent);
    try {
      await this.#o.call("settings.set", { key: ZOOM_KEY, value: this.#percent });
    } catch (err) {
      this.#o.warn?.(`could not store ${ZOOM_KEY}: ${String(err)}`);
    }
  }

  zoomIn(): Promise<void> {
    return this.set(zoomStep(this.#percent, 1));
  }

  zoomOut(): Promise<void> {
    return this.set(zoomStep(this.#percent, -1));
  }

  reset(): Promise<void> {
    return this.set(ZOOM_DEFAULT);
  }

  /** `settings.changed` from any device, including Settings → Appearance in this app. */
  onSettingsChanged(entries: readonly { key: string; value: unknown }[]): void {
    for (const e of entries) {
      if (e.key === ZOOM_KEY) this.apply(clampZoom(e.value));
    }
  }
}
