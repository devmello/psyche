import { isHostHelperKind } from "../helper-launcher.ts";
import type { VoiceKeySource } from "../screen-ask/voice-key.ts";
import {
  DEFAULT_DICTATION_SETTINGS,
  DICTATION_SETTING_KEYS,
  type DictationKey,
  type DictationSettings,
  holdKeyOf,
  parseDictationSettings,
  type SystemDictation,
  sameKey,
} from "./controller.ts";
import { KeyGesture } from "./key-gesture.ts";

/** System Settings › Privacy & Security › Accessibility (Psyche Helper needs the grant). */
export const ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/**
 * The settings page Settings → Voice & dictation opens when dictation cannot listen. Windows has
 * no grant for a keyboard hook; what can stop dictation there is the microphone privacy switch.
 */
export function dictationSettingsUrl(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "ms-settings:privacy-microphone" : ACCESSIBILITY_SETTINGS_URL;
}

/** What Settings → Voice & dictation shows (`SystemDictationStatus` in @psyche/web/platform). */
export interface DictationStatus {
  helper: "online" | "offline";
  accessibility: "granted" | "missing" | "unknown";
  watching: boolean;
  hotkeyTaken?: string;
  /**
   * Windows: the keyboard layout in use has AltGr, so Right Alt types characters there and makes
   * a poor hold-to-talk key (Settings warns). Absent when unknown or not Windows.
   */
  altGrLayout?: boolean;
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
  /**
   * The voice key went down or up: the helper watches it beside the dictation key, and main
   * opens the voice pop-up (the ask panel) with it (`VoiceKeyListener`).
   */
  onVoiceKey?: (down: boolean) => void;
  /** The dictation or voice key was double-tapped: open "Ask about my screen". */
  onKeyDoubleTap?: () => void;
  /** Talk with Psyche was turned on or off (its key is armed or not): the pop-up's window. */
  onVoiceEnabled?: (on: boolean) => void;
  /** Default `process.platform`: which key names share a physical key (Windows). */
  platform?: NodeJS.Platform;
  /** Windows: whether the keyboard layout in use has AltGr (`psyche-helper --keyboard-layout`). */
  altGrLayout?: () => Promise<boolean | undefined>;
}

/** Settings that arm the voice conversation key (spec §6.4). */
export const VOICE_KEY_SETTING_KEYS = [
  "voice.conversation.enabled",
  "voice.conversation.key",
] as const;

/** The voice key, or null when voice conversation is off or the key collides with dictation's. */
export function parseVoiceKey(
  values: Record<string, unknown>,
  dictation: DictationSettings,
  platform: NodeJS.Platform = process.platform,
): DictationKey | null {
  if (values["voice.conversation.enabled"] !== true) return null;
  const key = holdKeyOf(values["voice.conversation.key"], "voice", platform);
  // On Windows `fn` and `rightOption` are both Right Alt: that is a collision too.
  return dictation.enabled && sameKey(key, dictation.key, platform) ? null : key;
}

/**
 * Keeps system-wide dictation in step with Settings → Voice & dictation and the Gateway: reads
 * the `voice.*` settings once paired, arms the helper's hold-to-talk watch (`dictation.watch`),
 * registers the toggle hotkey in the main process, and routes `dictation.key`, `voice.segment`,
 * `settings.changed` and `node.updated` (the helper came back) to the controller.
 *
 * It is also the macOS `VoiceKeySource`: the voice key comes from the same helper watch.
 */
export class DictationService implements VoiceKeySource {
  readonly #o: DictationServiceOptions;
  #settings: DictationSettings = DEFAULT_DICTATION_SETTINGS;
  #voiceKey: DictationKey | null = null;
  #hotkey = "";
  #watching = false;
  #hotkeyTaken = "";
  #status: DictationStatus = { helper: "offline", accessibility: "unknown", watching: false };

  // A key needs a 250 ms hold to act (fn doubles as the input-source key); see key-gesture.ts.
  readonly #keyVoice: KeyGesture;
  readonly #keyDictation: KeyGesture;

  constructor(opts: DictationServiceOptions) {
    this.#o = opts;
    const gesture = (hold: (down: boolean) => void) =>
      new KeyGesture({
        onHoldStart: () => hold(true),
        onHoldEnd: () => hold(false),
        onDoubleTap: () => this.#o.onKeyDoubleTap?.(),
      });
    this.#keyVoice = gesture((down) => this.#o.onVoiceKey?.(down));
    this.#keyDictation = gesture((down) => this.#o.dictation.onKey(down));
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
      const res = (await this.#o.call("settings.get", {
        keys: [...DICTATION_SETTING_KEYS, ...VOICE_KEY_SETTING_KEYS],
      })) as {
        settings?: Record<string, unknown>;
      };
      values = res?.settings ?? {};
    } catch (err) {
      this.#o.warn?.(`could not read voice settings: ${String(err)}`);
    }
    const platform = this.#o.platform ?? process.platform;
    const settings = parseDictationSettings(values, platform);
    this.#voiceKey = parseVoiceKey(values, settings, platform);
    if (platform === "win32" && this.#o.altGrLayout !== undefined) {
      // Read again on each load: the owner may have switched layouts since.
      const altGr = await this.#o.altGrLayout().catch(() => undefined);
      if (altGr !== undefined) this.#update({ altGrLayout: altGr });
    }
    this.#o.onVoiceEnabled?.(this.#voiceKey !== null);
    await this.apply(settings);
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
      if (typeof p.down !== "boolean") return;
      if (p.role === "voice") {
        if (p.key !== this.#voiceKey) return;
        this.#keyVoice.key(p.down);
        return;
      }
      if (p.key !== this.#settings.key) return;
      this.#keyDictation.key(p.down);
    } else if (event === "voice.segment") {
      const seg = p.segment as { text?: unknown; final?: unknown } | undefined;
      if (typeof p.sessionId === "string" && typeof seg?.text === "string")
        this.#o.dictation.onSegment(p.sessionId, { text: seg.text, final: seg.final === true });
    } else if (event === "settings.changed") {
      const entries = (p.entries as { key: string; value: unknown }[] | undefined) ?? [];
      const watched = [...DICTATION_SETTING_KEYS, ...VOICE_KEY_SETTING_KEYS] as readonly string[];
      if (entries.some((e) => watched.includes(e.key))) void this.load();
    } else if (event === "node.updated") {
      // This computer's helper, whichever OS: the Mac helper or the Windows helper.
      const node = p.node as { kind?: unknown; status?: unknown } | undefined;
      if (isHostHelperKind(node?.kind) && node?.status === "online") void this.#arm();
      if (isHostHelperKind(node?.kind) && node?.status !== "online") {
        this.#watching = false;
        this.#update({ helper: "offline", watching: false });
      }
    }
  }

  /** The Gateway connection dropped: the watch ended with it. */
  onDisconnected(): void {
    this.#watching = false;
    this.#update({ helper: "offline", watching: false });
    this.#keyVoice.reset();
    this.#keyDictation.reset();
    this.#o.dictation.cancel();
  }

  dispose(): void {
    this.#keyVoice.reset();
    this.#keyDictation.reset();
    this.#registerHotkey("");
    this.#o.dictation.cancel();
  }

  async #arm(): Promise<void> {
    const key = this.#settings.enabled ? this.#settings.key : null;
    // With voice conversation on, one watch carries both keys (a second watch would replace the
    // first). A helper without two-key support keeps watching `key` only.
    const params =
      this.#voiceKey === null
        ? { key }
        : {
            key,
            keys: [
              ...(key === null ? [] : [{ key, role: "dictation" as const }]),
              { key: this.#voiceKey, role: "voice" as const },
            ],
          };
    try {
      const res = (await this.#o.call("dictation.watch", params)) as { watching?: boolean };
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

  /**
   * Whether `accelerator` could be the toggle hotkey, asked before Settings saves it: briefly
   * registering it tells whether another app (or Psyche itself) already holds it.
   */
  checkHotkey(accelerator: string): "ok" | "taken" | "invalid" {
    if (accelerator === this.#hotkey) return "ok";
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
