/**
 * Settings → Computer use → Psyche points (docs/design/psyche-points-2026.md §6.2): whether the
 * menu-bar row is shown. It is `points.enabled`, off until the owner's pass. Read once paired and
 * again on `settings.changed`, like Ask about screen. A client of another computer's Gateway never
 * shows it (`disabled`): the windows to point at would be this Mac's, the guidance the Host's.
 */

export const POINTS_SETTING_KEY = "points.enabled";

export interface PointsSettingOptions {
  call: (method: string, params: unknown) => Promise<unknown>;
  onChange: (enabled: boolean) => void;
  warn?: (message: string) => void;
  disabled?: boolean;
}

export class PointsSetting {
  readonly #o: PointsSettingOptions;
  #enabled = false;

  constructor(opts: PointsSettingOptions) {
    this.#o = opts;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  async load(): Promise<void> {
    if (this.#o.disabled === true) return this.#set(false);
    try {
      const res = (await this.#o.call("settings.get", { keys: [POINTS_SETTING_KEY] })) as {
        settings?: Record<string, unknown>;
      };
      this.#set(res?.settings?.[POINTS_SETTING_KEY] === true);
    } catch (err) {
      this.#o.warn?.(`could not read the Psyche points setting: ${String(err)}`);
      this.#set(false);
    }
  }

  onEvent(event: string, payload: unknown): void {
    if (this.#o.disabled === true || event !== "settings.changed") return;
    const entries = ((payload as { entries?: { key: string }[] } | null)?.entries ?? []) as {
      key: string;
    }[];
    if (entries.some((e) => e.key === POINTS_SETTING_KEY)) void this.load();
  }

  #set(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    this.#o.onChange(enabled);
  }
}
