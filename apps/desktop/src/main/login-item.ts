/**
 * "Open Psyche at login" (Settings → Appearance → Background). On, macOS starts Psyche when the
 * owner signs in, with `--background`: no window, no Dock icon, only the menu bar item, with the
 * agent browser host and its bridge up, so scheduled runs that need the browser find it. Off is
 * the default; the Gateway can still start the app for a run that needs it.
 */
export const OPEN_AT_LOGIN_KEY = "appearance.openAtLogin";

export const BACKGROUND_ARG = "--background";

/** The slice of Electron's `app` the login item drives. */
export interface LoginApp {
  setLoginItemSettings(settings: { openAtLogin: boolean; args?: string[] }): void;
}

export function openAtLogin(value: unknown): boolean {
  return value === true;
}

export class LoginItem {
  readonly #app: LoginApp;
  readonly #platform: NodeJS.Platform;
  readonly #warn: ((message: string) => void) | undefined;

  constructor(app: LoginApp, o: { platform?: NodeJS.Platform; warn?: (m: string) => void } = {}) {
    this.#app = app;
    this.#platform = o.platform ?? process.platform;
    this.#warn = o.warn;
  }

  set(value: unknown): void {
    if (this.#platform !== "darwin") return;
    try {
      this.#app.setLoginItemSettings({ openAtLogin: openAtLogin(value), args: [BACKGROUND_ARG] });
    } catch (err) {
      this.#warn?.(`could not set the login item: ${String(err)}`);
    }
  }

  onSettingsChanged(entries: readonly { key: string; value: unknown }[]): void {
    const entry = entries.find((e) => e.key === OPEN_AT_LOGIN_KEY);
    if (entry) this.set(entry.value);
  }

  /** Reads the stored setting once paired, so a changed value from another device applies too. */
  async load(call: (method: string, params: unknown) => Promise<unknown>): Promise<void> {
    try {
      const res = (await call("settings.get", { keys: [OPEN_AT_LOGIN_KEY] })) as {
        settings?: Record<string, unknown>;
      };
      // Never set: leave the login item as the owner has it in System Settings.
      const value = res.settings?.[OPEN_AT_LOGIN_KEY];
      if (value !== undefined) this.set(value);
    } catch (err) {
      this.#warn?.(`could not read ${OPEN_AT_LOGIN_KEY}: ${String(err)}`);
    }
  }
}
