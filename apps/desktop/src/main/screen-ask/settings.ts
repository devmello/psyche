import type { ShortcutRegistry } from "../dictation/service.ts";

/**
 * Settings → Voice & dictation → Ask about screen (docs/design/screen-ask-2026.md §6): whether
 * the ask shortcut is on, and which one. Read once paired and again on `settings.changed`; the
 * default ⌥⇧Space falls back to ⌃⌥⇧Space when another app holds it (like quick entry). Off
 * unregisters the shortcut and turns off the panel's "screen" source: the window goes unless
 * Talk with Psyche keeps it for the voice pop-up (`voicePopup`), and the capture UI goes either
 * way. The menu items stay; they open nothing while it is off.
 */

export const SCREEN_ASK_SETTING_KEYS = ["screenAsk.enabled", "screenAsk.shortcut"] as const;
export const DEFAULT_SCREEN_ASK_SHORTCUT = "Alt+Shift+Space";
const FALLBACK_SHORTCUT = "Control+Alt+Shift+Space";

export interface ScreenAskSettings {
  enabled: boolean;
  shortcut: string;
}

export function parseScreenAskSettings(values: Record<string, unknown>): ScreenAskSettings {
  const raw = values["screenAsk.shortcut"];
  return {
    enabled: values["screenAsk.enabled"] !== false,
    shortcut:
      typeof raw === "string" && raw.trim() !== "" && raw.length <= 64
        ? raw
        : DEFAULT_SCREEN_ASK_SHORTCUT,
  };
}

export interface ScreenAskShortcutOptions {
  call: (method: string, params: unknown) => Promise<unknown>;
  shortcuts?: ShortcutRegistry;
  trigger: () => void;
  setEnabled: (on: boolean) => void;
  warn?: (message: string) => void;
}

export class ScreenAskShortcut {
  readonly #o: ScreenAskShortcutOptions;
  #current = "";
  #settings: ScreenAskSettings = { enabled: true, shortcut: DEFAULT_SCREEN_ASK_SHORTCUT };

  constructor(opts: ScreenAskShortcutOptions) {
    this.#o = opts;
  }

  /** The accelerator registered now ("" when off or taken). */
  get current(): string {
    return this.#current;
  }

  get settings(): ScreenAskSettings {
    return this.#settings;
  }

  async load(): Promise<void> {
    let values: Record<string, unknown> = {};
    try {
      const res = (await this.#o.call("settings.get", { keys: [...SCREEN_ASK_SETTING_KEYS] })) as {
        settings?: Record<string, unknown>;
      };
      values = res?.settings ?? {};
    } catch (err) {
      this.#o.warn?.(`could not read Ask about screen settings: ${String(err)}`);
    }
    this.apply(parseScreenAskSettings(values));
  }

  apply(settings: ScreenAskSettings): void {
    this.#settings = settings;
    this.#o.setEnabled(settings.enabled);
    this.#register(settings.enabled ? settings.shortcut : "");
  }

  onEvent(event: string, payload: unknown): void {
    if (event !== "settings.changed") return;
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
    const tries =
      accelerator === DEFAULT_SCREEN_ASK_SHORTCUT
        ? [accelerator, FALLBACK_SHORTCUT]
        : [accelerator];
    for (const a of tries) {
      try {
        if (shortcuts.register(a, () => this.#o.trigger())) {
          this.#current = a;
          return;
        }
      } catch {
        // An accelerator Electron can't parse: try the next, or stay unregistered.
      }
    }
    this.#o.warn?.(`the Ask about screen shortcut ${accelerator} is taken by another app`);
  }
}
