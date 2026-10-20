/**
 * System-wide dictation (features J9, Q2; UI design §3.18 "Voice & dictation", §4.11 "Hold fn").
 * The main process owns the session: a hold-to-talk key (watched by the Mac helper, since
 * Electron cannot see fn or key-up) or the toggle hotkey starts it, the HUD window captures the
 * microphone and shows partials, audio goes through the Gateway's `voice.*` methods (the same
 * engine and custom vocabulary as the composer), and on release the final text is inserted into
 * the app that had focus with `dictation.insert`.
 *
 * Text inserted into another app is the owner's keystrokes: it never goes to a thread, the agent
 * or memory. When Psyche itself has focus the helper answers `own_window` and nothing happens
 * here; the composer dictates there.
 */

export type DictationKey = "fn" | "rightOption" | "rightCommand";
export type DictationMode = "hold" | "toggle";

export interface DictationSettings {
  enabled: boolean;
  key: DictationKey;
  mode: DictationMode;
  /** Electron accelerator that toggles dictation from anywhere; empty = none. */
  hotkey: string;
}

export const DICTATION_SETTING_KEYS = [
  "voice.systemWide",
  "voice.pushToTalk",
  "voice.mode",
  "voice.hotkey",
] as const;

export const DEFAULT_DICTATION_SETTINGS: DictationSettings = {
  enabled: true,
  key: "fn",
  mode: "hold",
  hotkey: "",
};

const KEYS: readonly DictationKey[] = ["fn", "rightOption", "rightCommand"];

/** Reads the `voice.*` settings; anything unknown falls back to the default. */
export function parseDictationSettings(values: Record<string, unknown>): DictationSettings {
  const key = values["voice.pushToTalk"];
  const hotkey = values["voice.hotkey"];
  return {
    enabled: values["voice.systemWide"] !== false,
    key: KEYS.includes(key as DictationKey) ? (key as DictationKey) : "fn",
    mode: values["voice.mode"] === "toggle" ? "toggle" : "hold",
    hotkey: typeof hotkey === "string" ? hotkey.trim().slice(0, 64) : "",
  };
}

export interface DictationTarget {
  pid: number;
  bundleId: string | null;
  appName: string;
  insertable: boolean;
  refusal?: string;
}

export type HudState =
  | { phase: "listening"; app: string; text: string }
  | { phase: "finishing"; app: string; text: string }
  | { phase: "message"; text: string };

export interface DictationHud {
  show(state: HudState): void;
  hide(): void;
}

/** Microphone capture in the HUD renderer; chunks arrive through `onAudio`. */
export interface DictationCapture {
  start(): Promise<void>;
  /** Resolves once the last chunk was handed to `onAudio`. */
  stop(): Promise<void>;
}

export interface SystemDictationOptions {
  call: (method: string, params: unknown) => Promise<unknown>;
  hud: DictationHud;
  capture: DictationCapture;
  warn?: (message: string) => void;
  /** A hold shorter than this is a stray tap (fn alone, fn+key): cancelled silently. */
  minHoldMs?: number;
  maxDurationMs?: number;
  messageMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

export const AUDIO_FORMAT = { encoding: "pcm_s16le", sampleRate: 16_000, channels: 1 } as const;

const REFUSALS: Record<string, string> = {
  secure_field: "Psyche never types into password fields.",
  not_editable: "Click into a text field, then dictate.",
  focus_changed: "Focus moved to another app, so nothing was inserted.",
  no_focus: "No app has keyboard focus.",
};

function errorCode(err: unknown): { code: string; refusal?: string } {
  const e = err as { code?: unknown; details?: { refusal?: unknown; reason?: unknown } } | null;
  const refusal = e?.details?.refusal ?? e?.details?.reason;
  return {
    code: typeof e?.code === "string" ? e.code : "internal",
    ...(typeof refusal === "string" ? { refusal } : {}),
  };
}

type Phase =
  | { kind: "idle" }
  | { kind: "starting"; token: number }
  | {
      kind: "listening";
      token: number;
      sessionId: string;
      target: DictationTarget;
      startedAt: number;
      finals: string[];
      partial: string;
    }
  | { kind: "finishing"; token: number };

export class SystemDictation {
  readonly #o: Required<
    Pick<SystemDictationOptions, "minHoldMs" | "maxDurationMs" | "messageMs" | "now" | "setTimer">
  > &
    SystemDictationOptions;
  #settings: DictationSettings = DEFAULT_DICTATION_SETTINGS;
  #phase: Phase = { kind: "idle" };
  #token = 0;
  #seq = 0;
  #pushes: Promise<unknown> = Promise.resolve();
  #cancelTimer: (() => void) | undefined;
  #hideTimer: (() => void) | undefined;
  /** A key-up that arrived while `voice.start` was still in flight. */
  #releasedEarly = false;

  constructor(opts: SystemDictationOptions) {
    this.#o = {
      minHoldMs: 250,
      maxDurationMs: 120_000,
      messageMs: 2_500,
      now: () => Date.now(),
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
      ...opts,
    };
  }

  get settings(): DictationSettings {
    return this.#settings;
  }

  get phase(): Phase["kind"] {
    return this.#phase.kind;
  }

  configure(settings: DictationSettings): void {
    this.#settings = settings;
    if (!settings.enabled) this.cancel();
  }

  /** `dictation.key` from the helper's hold-to-talk watch. */
  onKey(down: boolean): void {
    if (!this.#settings.enabled) return;
    if (this.#settings.mode === "toggle") {
      if (down) this.toggle();
      return;
    }
    if (down) void this.start();
    else void this.release();
  }

  /** The toggle hotkey (and the hold key in toggle mode): press to start, press to stop. */
  toggle(): void {
    if (!this.#settings.enabled) return;
    if (this.#phase.kind === "idle") void this.start();
    else if (this.#phase.kind === "listening") void this.finish(false);
  }

  async start(): Promise<void> {
    if (this.#phase.kind !== "idle") return;
    const token = ++this.#token;
    this.#phase = { kind: "starting", token };
    this.#releasedEarly = false;
    this.#clearHide();
    let target: DictationTarget | null;
    try {
      const res = (await this.#o.call("dictation.target", {})) as {
        target?: DictationTarget | null;
      };
      target = res?.target ?? null;
    } catch (err) {
      return this.#fail(token, err);
    }
    if (!this.#current(token)) return;
    if (!target?.insertable) {
      this.#phase = { kind: "idle" };
      // Psyche's own window: the composer dictates there; say nothing.
      if (target?.refusal === "own_window") return;
      return this.#message(REFUSALS[target?.refusal ?? "no_focus"] ?? REFUSALS.no_focus ?? "");
    }
    let sessionId: string;
    try {
      const res = (await this.#o.call("voice.start", { format: AUDIO_FORMAT })) as {
        sessionId?: string | null;
      };
      if (typeof res?.sessionId !== "string") throw { code: "unavailable" };
      sessionId = res.sessionId;
    } catch (err) {
      return this.#fail(token, err);
    }
    if (!this.#current(token)) {
      void this.#o.call("voice.cancel", { sessionId }).catch(() => undefined);
      return;
    }
    this.#seq = 0;
    this.#pushes = Promise.resolve();
    this.#phase = {
      kind: "listening",
      token,
      sessionId,
      target,
      startedAt: this.#o.now(),
      finals: [],
      partial: "",
    };
    this.#o.hud.show({ phase: "listening", app: target.appName, text: "" });
    try {
      await this.#o.capture.start();
    } catch {
      this.#abort(sessionId);
      return this.#message("Psyche can't use the microphone.");
    }
    this.#cancelTimer = this.#o.setTimer(() => void this.finish(false), this.#o.maxDurationMs);
    if (this.#releasedEarly && this.#settings.mode === "hold") void this.release();
  }

  async release(): Promise<void> {
    if (this.#phase.kind === "starting") {
      this.#releasedEarly = true;
      return;
    }
    if (this.#phase.kind !== "listening") return;
    const held = this.#o.now() - this.#phase.startedAt;
    await this.finish(held < this.#o.minHoldMs);
  }

  /** Audio from the HUD (base64 PCM s16le, 16 kHz mono), pushed in order. */
  onAudio(chunk: string): void {
    const p = this.#phase;
    if (p.kind !== "listening" || chunk.length === 0) return;
    const seq = this.#seq++;
    const { sessionId } = p;
    this.#pushes = this.#pushes.then(() =>
      this.#o.call("voice.push", { sessionId, seq, audio: chunk }).catch((err: unknown) => {
        this.#o.warn?.(`voice.push failed: ${errorCode(err).code}`);
      }),
    );
  }

  /** `voice.segment` for this device. */
  onSegment(sessionId: string, segment: { text: string; final: boolean }): void {
    const p = this.#phase;
    if (p.kind !== "listening" || p.sessionId !== sessionId) return;
    if (segment.final) {
      if (segment.text.trim()) p.finals.push(segment.text.trim());
      p.partial = "";
    } else p.partial = segment.text.trim();
    this.#o.hud.show({ phase: "listening", app: p.target.appName, text: this.#text(p) });
  }

  /** Ends the session: inserts the final text unless `discard`. */
  async finish(discard: boolean): Promise<void> {
    const p = this.#phase;
    if (p.kind !== "listening") return;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    this.#phase = { kind: "finishing", token: p.token };
    if (!discard)
      this.#o.hud.show({ phase: "finishing", app: p.target.appName, text: this.#text(p) });
    await this.#o.capture.stop().catch(() => undefined);
    await this.#pushes;
    if (discard) {
      this.#abort(p.sessionId);
      this.#o.hud.hide();
      return;
    }
    let text = "";
    try {
      const res = (await this.#o.call("voice.stop", { sessionId: p.sessionId })) as {
        transcript?: { text?: string };
      };
      text = (res?.transcript?.text ?? "").trim();
    } catch (err) {
      return this.#fail(p.token, err);
    }
    if (text === "") {
      this.#phase = { kind: "idle" };
      this.#o.hud.hide();
      return;
    }
    try {
      await this.#o.call("dictation.insert", { text, expectPid: p.target.pid });
      this.#phase = { kind: "idle" };
      this.#o.hud.hide();
    } catch (err) {
      this.#phase = { kind: "idle" };
      const { refusal } = errorCode(err);
      this.#message(
        (refusal && REFUSALS[refusal]) ?? "Psyche couldn't insert the text. Nothing was typed.",
      );
    }
  }

  cancel(): void {
    const p = this.#phase;
    this.#token++;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    if (p.kind === "listening") {
      void this.#o.capture.stop().catch(() => undefined);
      void this.#o.call("voice.cancel", { sessionId: p.sessionId }).catch(() => undefined);
    }
    this.#phase = { kind: "idle" };
    this.#o.hud.hide();
  }

  #text(p: { finals: string[]; partial: string }): string {
    return [...p.finals, p.partial].filter((s) => s !== "").join(" ");
  }

  #current(token: number): boolean {
    return this.#phase.kind !== "idle" && "token" in this.#phase && this.#phase.token === token;
  }

  #abort(sessionId: string): void {
    void this.#o.call("voice.cancel", { sessionId }).catch(() => undefined);
    this.#phase = { kind: "idle" };
  }

  #fail(token: number, err: unknown): void {
    if (this.#phase.kind !== "idle" && "token" in this.#phase && this.#phase.token !== token)
      return;
    this.#phase = { kind: "idle" };
    const { code } = errorCode(err);
    this.#o.warn?.(`dictation failed: ${code}`);
    this.#message(
      code === "unavailable"
        ? "Dictation needs the Psyche helper and a speech engine on this Mac."
        : code === "forbidden" || code === "policy_denied"
          ? "Psyche Helper needs Accessibility to dictate into other apps."
          : "Psyche couldn't dictate. Try again.",
    );
  }

  #message(text: string): void {
    this.#o.hud.show({ phase: "message", text });
    this.#clearHide();
    this.#hideTimer = this.#o.setTimer(() => {
      this.#hideTimer = undefined;
      if (this.#phase.kind === "idle") this.#o.hud.hide();
    }, this.#o.messageMs);
  }

  #clearHide(): void {
    this.#hideTimer?.();
    this.#hideTimer = undefined;
  }
}
