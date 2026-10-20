import {
  DEFAULT_DICTATION_SETTINGS,
  DICTATION_SETTING_KEYS,
  type DictationSettings,
  parseDictationSettings,
  type SystemDictation,
} from "./controller.ts";

/** System Settings › Privacy & Security › Accessibility (Psyche Helper needs the grant). */
export const ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/** What Settings → Voice & dictation shows (`SystemDictationStatus` in @psyche/web/platform). */
export interface DictationStatus {
  helper: "online" | "offline";
  accessibility: "granted" | "missing" | "unknown";
  watching: boolean;
  hotkeyTaken?: string;
}

/** Electron's `globalShortcut`, narrowed for tests. */
export interface ShortcutRegistry {
  register(accelerator: string, cb: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface DictationServiceOptions {
  dictation: SystemDictation;
  call: (method: string, params: unknown) => Promise<unknown>;
  shortcuts?: ShortcutRegistry;
  warn?: (message: string) => void;
  onStatus?: (status: DictationStatus) => void;
}

/**
 * Keeps system-wide dictation in step with Settings → Voice & dictation and the Gateway: reads
 * the `voice.*` settings once paired, arms the helper's hold-to-talk watch (`dictation.watch`),
 * registers the toggle hotkey in the main process, and routes `dictation.key`, `voice.segment`,
 * `settings.changed` and `node.updated` (the helper came back) to the controller.
 */
export class DictationService {
  readonly #o: DictationServiceOptions;
  #settings: DictationSettings = DEFAULT_DICTATION_SETTINGS;
  #hotkey = "";
  #watching = false;
  #hotkeyTaken = "";
  #status: DictationStatus = { helper: "offline", accessibility: "unknown", watching: false };

  constructor(opts: DictationServiceOptions) {
    this.#o = opts;
  }

  get watching(): boolean {
    return this.#watching;
  }

  get hotkey(): string {
    return this.#hotkey;
  }

  get status(): DictationStatus {
    return this.#status;
  }

  /** Settings' "Check again" after the owner granted Accessibility. */
  recheck(): Promise<void> {
    return this.#arm();
  }

  /** Reads the settings (once paired) and applies them. */
  async load(): Promise<void> {
    let values: Record<string, unknown> = {};
    try {
      const res = (await this.#o.call("settings.get", { keys: [...DICTATION_SETTING_KEYS] })) as {
        settings?: Record<string, unknown>;
      };
      values = res?.settings ?? {};
    } catch (err) {
      this.#o.warn?.(`could not read voice settings: ${String(err)}`);
    }
    await this.apply(parseDictationSettings(values));
  }

  async apply(settings: DictationSettings): Promise<void> {
    this.#settings = settings;
    this.#o.dictation.configure(settings);
    this.#registerHotkey(settings.enabled ? settings.hotkey : "");
    await this.#arm();
  }

  /** Every Gateway event the main process receives. */
  onEvent(event: string, payload: unknown): void {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (event === "dictation.key") {
      if (typeof p.down === "boolean" && p.key === this.#settings.key)
        this.#o.dictation.onKey(p.down);
    } else if (event === "voice.segment") {
      const seg = p.segment as { text?: unknown; final?: unknown } | undefined;
      if (typeof p.sessionId === "string" && typeof seg?.text === "string")
        this.#o.dictation.onSegment(p.sessionId, { text: seg.text, final: seg.final === true });
    } else if (event === "settings.changed") {
      const entries = (p.entries as { key: string; value: unknown }[] | undefined) ?? [];
      if (entries.some((e) => (DICTATION_SETTING_KEYS as readonly string[]).includes(e.key)))
        void this.load();
    } else if (event === "node.updated") {
      const node = p.node as { kind?: unknown; status?: unknown } | undefined;
      if (node?.kind === "mac-helper" && node.status === "online") void this.#arm();
      if (node?.kind === "mac-helper" && node.status !== "online") {
        this.#watching = false;
        this.#update({ helper: "offline", watching: false });
      }
    }
  }

  /** The Gateway connection dropped: the watch ended with it. */
  onDisconnected(): void {
    this.#watching = false;
    this.#update({ helper: "offline", watching: false });
    this.#o.dictation.cancel();
  }

  dispose(): void {
    this.#registerHotkey("");
    this.#o.dictation.cancel();
  }

  async #arm(): Promise<void> {
    const key = this.#settings.enabled ? this.#settings.key : null;
    try {
      const res = (await this.#o.call("dictation.watch", { key })) as { watching?: boolean };
      this.#watching = res?.watching === true;
      // A watch that armed proves the helper has Accessibility; stopping one proves nothing.
      this.#update({
        helper: "online",
        watching: this.#watching,
        ...(this.#watching ? { accessibility: "granted" as const } : {}),
      });
    } catch (err) {
      this.#watching = false;
      const e = err as { code?: unknown; details?: { reason?: unknown; permission?: unknown } };
      if (e?.code === "unavailable") {
        // No helper yet: it arms on node.updated, not worth a warning.
        this.#update({ helper: "offline", accessibility: "unknown", watching: false });
        return;
      }
      const missing =
        e?.details?.reason === "permission_missing" || e?.details?.permission === "accessibility";
      this.#update({
        helper: "online",
        watching: false,
        accessibility: missing ? "missing" : "unknown",
      });
      if (!missing) this.#o.warn?.(`dictation.watch failed: ${String(e?.code ?? err)}`);
    }
  }

  #update(patch: Partial<DictationStatus>): void {
    const next: DictationStatus = { ...this.#status, ...patch };
    if (!this.#hotkeyTaken) delete next.hotkeyTaken;
    else next.hotkeyTaken = this.#hotkeyTaken;
    if (JSON.stringify(next) === JSON.stringify(this.#status)) return;
    this.#status = next;
    this.#o.onStatus?.(next);
  }

  #registerHotkey(accelerator: string): void {
    if (accelerator === this.#hotkey && !this.#hotkeyTaken) return;
    const shortcuts = this.#o.shortcuts;
    if (this.#hotkey) shortcuts?.unregister(this.#hotkey);
    this.#hotkey = "";
    this.#hotkeyTaken = "";
    if (accelerator && shortcuts) {
      try {
        if (shortcuts.register(accelerator, () => this.#o.dictation.toggle()))
          this.#hotkey = accelerator;
        else {
          this.#hotkeyTaken = accelerator;
          this.#o.warn?.(`the dictation hotkey ${accelerator} is taken by another app`);
        }
      } catch {
        this.#hotkeyTaken = accelerator;
        this.#o.warn?.(`the dictation hotkey ${accelerator} is not a valid shortcut`);
      }
    }
    this.#update({});
  }
}
