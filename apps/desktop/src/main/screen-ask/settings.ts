import type { ShortcutRegistry } from "../dictation/service.ts";
import { registerFirst, screenAskShortcuts } from "../shortcuts.ts";

/**
 * Settings → Voice & dictation → Ask about screen (docs/design/screen-ask-2026.md §6): whether
 * the ask shortcut is on, and which one. Read once paired and again on `settings.changed`; the
 * default ⌥⇧Space falls back to ⌃⌥⇧Space when another app holds it (like quick entry). Off
 * unregisters the shortcut and turns off the panel's "screen" source: the window goes unless
 * Talk with Psyche keeps it for the voice pop-up (`voicePopup`), and the capture UI goes either
 * way. The menu items stay; they open nothing while it is off.
 */

export const SCREEN_ASK_SETTING_KEYS = ["screenAsk.enabled", "screenAsk.shortcut"] as const;
/**
 * This OS's default: ⌥⇧Space (⌃⌥⇧Space when taken) on macOS, Ctrl+Alt+Shift+Space on Windows
 * (`screenAskShortcuts`).
 */
export const DEFAULT_SCREEN_ASK_SHORTCUT = screenAskShortcuts()[0] as string;

export interface ScreenAskSettings {
  enabled: boolean;
  shortcut: string;
}

export function parseScreenAskSettings(
  values: Record<string, unknown>,
  platform: NodeJS.Platform = process.platform,
): ScreenAskSettings {
  const raw = values["screenAsk.shortcut"];
  return {
    enabled: values["screenAsk.enabled"] !== false,
    shortcut:
      typeof raw === "string" && raw.trim() !== "" && raw.length <= 64
        ? raw
        : (screenAskShortcuts(platform)[0] as string),
  };
}

export interface ScreenAskShortcutOptions {
  call: (method: string, params: unknown) => Promise<unknown>;
  shortcuts?: ShortcutRegistry;
  trigger: () => void;
  setEnabled: (on: boolean) => void;
  warn?: (message: string) => void;
  /**
   * Never on, whatever the settings (and the defaults) say, and nothing is read from a Gateway:
   * a client of another computer's Gateway would capture this Mac's screen and send it to the
   * Host (remote-gateway design §4.2).
   */
  disabled?: boolean;
  /** Default `process.platform`: which default shortcut (and fallback) applies. */
  platform?: NodeJS.Platform;
}

export class ScreenAskShortcut {
  readonly #o: ScreenAskShortcutOptions;
  #current = "";
  #settings: ScreenAskSettings;

  constructor(opts: ScreenAskShortcutOptions) {
    this.#o = opts;
    this.#settings = { enabled: true, shortcut: screenAskShortcuts(opts.platform)[0] as string };
  }

  /** The accelerator registered now ("" when off or taken). */
  get current(): string {
    return this.#current;
  }

  get settings(): ScreenAskSettings {
    return this.#settings;
  }

  async load(): Promise<void> {
    if (this.#o.disabled === true) return this.apply(this.#settings);
    let values: Record<string, unknown> = {};
    try {
      const res = (await this.#o.call("settings.get", { keys: [...SCREEN_ASK_SETTING_KEYS] })) as {
        settings?: Record<string, unknown>;
      };
      values = res?.settings ?? {};
    } catch (err) {
      this.#o.warn?.(`could not read Ask about screen settings: ${String(err)}`);
    }
    this.apply(parseScreenAskSettings(values, this.#o.platform));
  }

  apply(requested: ScreenAskSettings): void {
    const settings = this.#o.disabled === true ? { ...requested, enabled: false } : requested;
    this.#settings = settings;
    this.#o.setEnabled(settings.enabled);
    this.#register(settings.enabled ? settings.shortcut : "");
  }

  onEvent(event: string, payload: unknown): void {
    if (this.#o.disabled === true || event !== "settings.changed") return;
    const entries = ((payload as { entries?: { key: string }[] } | null)?.entries ?? []) as {
      key: string;
    }[];
    if (entries.some((e) => (SCREEN_ASK_SETTING_KEYS as readonly string[]).includes(e.key)))
      void this.load();
  }

  /** Whether Settings may save `accelerator` for Ask about screen (its own counts as free). */
  check(accelerator: string): "ok" | "taken" | "invalid" {
    if (accelerator === this.#current) return "ok";
    const shortcuts = this.#o.shortcuts;
    if (!shortcuts) return "ok";
    try {
      if (!shortcuts.register(accelerator, () => undefined)) return "taken";
      shortcuts.unregister(accelerator);
      return "ok";
    } catch {
      return "invalid";
    }
  }

  dispose(): void {
    this.#register("");
  }

  #register(accelerator: string): void {
    const shortcuts = this.#o.shortcuts;
    if (accelerator === this.#current && accelerator !== "") return;
    if (this.#current) shortcuts?.unregister(this.#current);
    this.#current = "";
    if (!accelerator || !shortcuts) return;
    const defaults = screenAskShortcuts(this.#o.platform);
    const tries = accelerator === defaults[0] ? defaults : [accelerator];
    this.#current = registerFirst(shortcuts, tries, () => this.#o.trigger());
    if (this.#current !== "") return;
    this.#o.warn?.(`the Ask about screen shortcut ${accelerator} is taken by another app`);
  }
}
