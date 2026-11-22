import { traitsFor } from "../platform/index.ts";
import type { ShortcutRegistry } from "./dictation/service.ts";

/**
 * Global shortcut defaults per OS (docs/06 §3.21, docs/design/screen-ask-2026.md §6). macOS keeps
 * ⌥Space / ⌥⇧Space. On Windows Alt+Space opens every window's system menu, so quick entry is
 * Ctrl+Alt+Space and Ask about my screen Ctrl+Alt+Shift+Space (neither is a Windows or Office
 * shortcut). Each list is tried in order when the owner has not chosen one: the first that no
 * other app holds wins.
 */
export function quickEntryShortcuts(platform: NodeJS.Platform = process.platform): string[] {
  // Linux: Alt+Space is the window menu on GNOME and KDE (platform/index.ts).
  if (platform === "linux") return [...traitsFor(platform).quickEntry];
  return platform === "win32"
    ? ["Control+Alt+Space", "Alt+Shift+Space"]
    : ["Alt+Space", "Control+Alt+Space"];
}

export function screenAskShortcuts(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32"
    ? ["Control+Alt+Shift+Space"]
    : ["Alt+Shift+Space", "Control+Alt+Shift+Space"];
}

/** The owner's quick-entry shortcut (an Electron accelerator); unset means the OS default. */
export const QUICK_ENTRY_SHORTCUT_KEY = "quickEntry.shortcut";

/** A stored accelerator, or undefined for unset / empty / too long. */
export function storedAccelerator(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" && value.length <= 64
    ? value.trim()
    : undefined;
}

/**
 * Registers the first accelerator of `tries` that is free; returns it ("" when none could be).
 * An accelerator Electron cannot parse counts as taken.
 */
export function registerFirst(
  shortcuts: ShortcutRegistry,
  tries: readonly string[],
  cb: () => void,
): string {
  for (const a of tries) {
    try {
      if (shortcuts.register(a, cb)) return a;
    } catch {
      // not a valid accelerator: try the next
    }
  }
  return "";
}

export interface QuickEntryShortcutOptions {
  call: (method: string, params: unknown) => Promise<unknown>;
  shortcuts?: ShortcutRegistry;
  toggle: () => void;
  platform?: NodeJS.Platform;
  warn?: (message: string) => void;
  /** The registered accelerator changed (the tray shows it). */
  onChange?: (accelerator: string) => void;
}

/**
 * The quick-entry (pop-up chat) shortcut: the OS default until `quickEntry.shortcut` says
 * otherwise, read once paired and again on `settings.changed`. Registered at launch, before the
 * Gateway answers, so the pop-up works from the first second.
 */
export class QuickEntryShortcut {
  readonly #o: QuickEntryShortcutOptions;
  #current = "";
  #chosen: string | undefined;

  constructor(opts: QuickEntryShortcutOptions) {
    this.#o = opts;
  }

  get current(): string {
    return this.#current;
  }

  /** Registers the stored choice, or the OS default list. */
  apply(chosen: string | undefined): void {
    this.#chosen = chosen;
    const shortcuts = this.#o.shortcuts;
    if (this.#current) shortcuts?.unregister(this.#current);
    this.#current = "";
    if (shortcuts) {
      const tries = chosen === undefined ? quickEntryShortcuts(this.#o.platform) : [chosen];
      this.#current = registerFirst(shortcuts, tries, this.#o.toggle);
      if (this.#current === "")
        this.#o.warn?.(`the quick entry shortcut ${tries.join(" / ")} is taken by another app`);
    }
    this.#o.onChange?.(this.#current);
  }

  /**
   * Whether `accelerator` could be the quick-entry shortcut, asked before Settings saves it: the
   * one registered now is fine; any other is registered for a moment to see whether another app
   * holds it. "" (back to the default) is always fine.
   */
  check(accelerator: string): "ok" | "taken" | "invalid" {
    if (accelerator === "" || accelerator === this.#current) return "ok";
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

  async load(): Promise<void> {
    try {
      const res = (await this.#o.call("settings.get", { keys: [QUICK_ENTRY_SHORTCUT_KEY] })) as {
        settings?: Record<string, unknown>;
      };
      const chosen = storedAccelerator(res?.settings?.[QUICK_ENTRY_SHORTCUT_KEY]);
      if (chosen !== this.#chosen || this.#current === "") this.apply(chosen);
    } catch (err) {
      this.#o.warn?.(`could not read ${QUICK_ENTRY_SHORTCUT_KEY}: ${String(err)}`);
    }
  }

  onEvent(event: string, payload: unknown): void {
    if (event !== "settings.changed") return;
    const entries = (payload as { entries?: { key: string }[] } | null)?.entries ?? [];
    if (entries.some((e) => e.key === QUICK_ENTRY_SHORTCUT_KEY)) void this.load();
  }

  dispose(): void {
    if (this.#current) this.#o.shortcuts?.unregister(this.#current);
    this.#current = "";
  }
}
