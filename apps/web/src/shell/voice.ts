/**
 * Composer dictation capture (feature Q1 UI). The shell captures audio and streams it to the
 * Gateway's `voice.*` methods (S17, `packages/protocol/src/methods/voice.ts`):
 *
 *   voice.start  {format, threadId?}        → {sessionId, location, engine}
 *   voice.push   {sessionId, seq, audio}    → {}
 *   voice.stop   {sessionId}                → {transcript: {text, segments}}
 *   voice.cancel {sessionId}                → {ok}
 *
 * with `voice.segment {sessionId, segment: {text, final}}` and `voice.ended {sessionId, reason}`
 * events for this device. When the engine policy picks a client engine, `voice.start` answers
 * `sessionId: null, location: "client"` and the shell dictates in the browser (Web Speech).
 *
 * Audio: mono PCM s16le at 16 kHz in ~100 ms chunks, base64 in `audio`.
 */

export const VOICE_SAMPLE_RATE = 16_000;

export const VOICE_FORMAT = {
  encoding: "pcm_s16le",
  sampleRate: VOICE_SAMPLE_RATE,
  channels: 1,
} as const;

/** Downsamples Float32 [-1, 1] audio to 16 kHz Int16 by averaging (good enough for speech). */
export function toPcm16(input: Float32Array, inputRate: number): Int16Array {
  const ratio = inputRate / VOICE_SAMPLE_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j] ?? 0;
    const v = Math.max(-1, Math.min(1, end > start ? sum / (end - start) : 0));
    out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
  }
  return out;
}

/** Standard base64 (with padding) of the chunk's little-endian bytes, as `voice.push` takes. */
export function pcmChunkToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export type VoiceCall = (method: string, params: unknown) => Promise<unknown>;

export interface AudioSource {
  /** Starts delivering Float32 frames; returns a stop function. */
  start(onFrames: (frames: Float32Array, sampleRate: number) => void): Promise<() => void>;
}

export interface VoiceSegment {
  text: string;
  final: boolean;
}

/** A running browser-side recognition (Web Speech). */
export interface LocalDictationSession {
  /** Stops listening and resolves once the last final arrived. */
  stop(): Promise<void>;
  cancel(): void;
}

/** Browser-side dictation for `location: "client"`; it opens the microphone itself. */
export interface LocalDictation {
  start(handlers: {
    onSegment: (segment: VoiceSegment) => void;
    onError: (code: string) => void;
    /** The recognizer ended without `stop()` (silence, browser limit). */
    onEnd: () => void;
  }): LocalDictationSession;
}

export interface VoiceCaptureOptions {
  /** Browser-side dictation for `location: "client"`. */
  local?: LocalDictation;
  /**
   * The session ended without `stop()` (Gateway idle timeout or engine error, the browser
   * recognizer giving up): the text heard so far, for the composer.
   */
  onInterrupted?: (text: string) => void;
}

export type VoiceState =
  | { phase: "idle" }
  | { phase: "starting" }
  /** `sessionId` is null while dictating in the browser; `partial` is everything heard so far. */
  | { phase: "listening"; sessionId: string | null; partial: string }
  | { phase: "finishing"; sessionId: string | null; partial: string }
  | { phase: "unavailable"; reason: string };

const START_FAILURES: Record<string, string> = {
  unknown_method: "Dictation needs the Gateway's voice service, which isn't available.",
  not_implemented: "Dictation needs the Gateway's voice service, which isn't available.",
  unavailable: "No speech engine is available. Connect the Mac helper or install a speech model.",
  rate_limited: "Dictation is already running on this device.",
};

export class VoiceCapture {
  private state: VoiceState = { phase: "idle" };
  private stopAudio: (() => void) | undefined;
  private local: LocalDictationSession | undefined;
  private seq = 0;
  private pushes: Promise<unknown> = Promise.resolve();
  private buffered: Int16Array[] = [];
  private bufferedSamples = 0;
  private finals: string[] = [];
  private volatile = "";
  private readonly call: VoiceCall;
  private readonly source: AudioSource;
  private readonly onState: (s: VoiceState) => void;
  private readonly opts: VoiceCaptureOptions;

  constructor(
    call: VoiceCall,
    source: AudioSource,
    onState: (s: VoiceState) => void,
    opts: VoiceCaptureOptions = {},
  ) {
    this.call = call;
    this.source = source;
    this.onState = onState;
    this.opts = opts;
  }

  getState(): VoiceState {
    return this.state;
  }

  private set(s: VoiceState): void {
    this.state = s;
    this.onState(s);
  }

  private heard(): string {
    return [...this.finals, this.volatile].filter(Boolean).join(" ");
  }

  private reset(): void {
    this.seq = 0;
    this.pushes = Promise.resolve();
    this.buffered = [];
    this.bufferedSamples = 0;
    this.finals = [];
    this.volatile = "";
  }

  async start(threadId?: string): Promise<void> {
    const { phase } = this.state;
    if (phase === "listening" || phase === "starting" || phase === "finishing") return;
    this.set({ phase: "starting" });
    let sessionId: string | null;
    try {
      const res = (await this.call("voice.start", {
        format: VOICE_FORMAT,
        ...(threadId ? { threadId } : {}),
      })) as { sessionId?: unknown; location?: unknown };
      if (typeof res?.sessionId === "string") sessionId = res.sessionId;
      else if (res?.sessionId === null && res.location === "client") sessionId = null;
      else throw new Error("bad voice.start result");
    } catch (err) {
      if (this.getState().phase !== "starting") return;
      const code = (err as { code?: string } | null)?.code ?? "";
      this.set({
        phase: "unavailable",
        reason: START_FAILURES[code] ?? "Psyche couldn't start dictation.",
      });
      return;
    }
    // Cancelled while voice.start was in flight (`set` changes the state behind TS's back).
    if (this.getState().phase !== "starting") {
      if (sessionId) void this.call("voice.cancel", { sessionId }).catch(() => undefined);
      return;
    }
    this.reset();
    if (sessionId === null) return this.startLocal();
    this.set({ phase: "listening", sessionId, partial: "" });
    try {
      const stop = await this.source.start((frames, rate) => this.onFrames(frames, rate));
      const now = this.getState();
      if (now.phase !== "listening" || now.sessionId !== sessionId) stop();
      else this.stopAudio = stop;
    } catch {
      void this.call("voice.cancel", { sessionId }).catch(() => undefined);
      this.set({ phase: "unavailable", reason: "Psyche can't use the microphone." });
    }
  }

  private startLocal(): void {
    const localDictation = this.opts.local;
    if (!localDictation) {
      this.set({
        phase: "unavailable",
        reason: "This browser can't dictate. Choose a Gateway speech engine in Settings.",
      });
      return;
    }
    this.set({ phase: "listening", sessionId: null, partial: "" });
    try {
      this.local = localDictation.start({
        onSegment: (segment) => this.applySegment(segment),
        onError: (code) => {
          if (this.state.phase !== "listening" || this.state.sessionId !== null) return;
          this.local?.cancel();
          this.local = undefined;
          this.interrupt(
            code === "not-allowed" || code === "service-not-allowed"
              ? "Psyche can't use the microphone."
              : "The browser stopped dictating.",
          );
        },
        onEnd: () => {
          if (this.state.phase !== "listening" || this.state.sessionId !== null) return;
          this.local = undefined;
          this.interrupt();
        },
      });
    } catch {
      this.local = undefined;
      this.set({ phase: "unavailable", reason: "This browser can't dictate." });
    }
  }

  private onFrames(frames: Float32Array, rate: number): void {
    if (this.state.phase !== "listening") return;
    const pcm = toPcm16(frames, rate);
    this.buffered.push(pcm);
    this.bufferedSamples += pcm.length;
    if (this.bufferedSamples >= VOICE_SAMPLE_RATE / 10) this.flush();
  }

  private flush(): void {
    if (this.state.phase !== "listening" && this.state.phase !== "finishing") return;
    const { sessionId } = this.state;
    if (sessionId === null || this.bufferedSamples === 0) return;
    const out = new Int16Array(this.bufferedSamples);
    let o = 0;
    for (const b of this.buffered) {
      out.set(b, o);
      o += b.length;
    }
    this.buffered = [];
    this.bufferedSamples = 0;
    const params = { sessionId, seq: this.seq++, audio: pcmChunkToBase64(out) };
    // Chunks go out one after another: the Gateway rejects them out of `seq` order.
    this.pushes = this.pushes.then(() => this.call("voice.push", params)).catch(() => undefined);
  }

  private applySegment(segment: VoiceSegment): void {
    if (this.state.phase !== "listening" && this.state.phase !== "finishing") return;
    const text = segment.text.trim();
    if (segment.final) {
      if (text) this.finals.push(text);
      this.volatile = "";
    } else this.volatile = text;
    this.set({ ...this.state, partial: this.heard() });
  }

  /** A `voice.segment` event (partials and finals, in order) for this device. */
  onSegment(sessionId: string, segment: VoiceSegment): void {
    if (
      (this.state.phase === "listening" || this.state.phase === "finishing") &&
      this.state.sessionId === sessionId
    )
      this.applySegment(segment);
  }

  /**
   * A `voice.ended` event. When the Gateway ended the session on its own (idle timeout, engine
   * error) the microphone closes and the text heard so far goes to `onInterrupted`.
   */
  onEnded(sessionId: string, reason: string): void {
    if (this.state.phase !== "listening" || this.state.sessionId !== sessionId) return;
    if (reason === "stopped" || reason === "cancelled") return;
    this.interrupt(reason === "error" ? "The speech engine stopped dictating." : undefined);
  }

  private interrupt(reason?: string): void {
    const said = this.heard();
    this.stopAudio?.();
    this.stopAudio = undefined;
    this.reset();
    this.set(reason ? { phase: "unavailable", reason } : { phase: "idle" });
    if (said) this.opts.onInterrupted?.(said);
  }

  /** Stops capture and returns the final text (empty when nothing was recognised). */
  async stop(): Promise<string> {
    if (this.state.phase !== "listening") return "";
    const { sessionId } = this.state;
    this.stopAudio?.();
    this.stopAudio = undefined;
    this.set({ phase: "finishing", sessionId, partial: this.state.partial });
    if (sessionId === null) {
      const local = this.local;
      this.local = undefined;
      await local?.stop().catch(() => undefined);
      return this.done(this.heard());
    }
    this.flush();
    await this.pushes;
    try {
      const res = (await this.call("voice.stop", { sessionId })) as {
        transcript?: { text?: unknown };
      };
      const text = res?.transcript?.text;
      return this.done(typeof text === "string" ? text.trim() : this.heard());
    } catch {
      return this.done(this.heard());
    }
  }

  private done(text: string): string {
    this.reset();
    this.set({ phase: "idle" });
    return text;
  }

  cancel(): void {
    if (
      (this.state.phase === "listening" || this.state.phase === "finishing") &&
      this.state.sessionId !== null
    ) {
      void this.call("voice.cancel", { sessionId: this.state.sessionId }).catch(() => undefined);
    }
    this.local?.cancel();
    this.local = undefined;
    this.stopAudio?.();
    this.stopAudio = undefined;
    this.reset();
    if (this.state.phase !== "idle") this.set({ phase: "idle" });
  }
}

/** Microphone source over getUserMedia + Web Audio (renderer only; audio never leaves to disk). */
export function microphoneSource(): AudioSource {
  return {
    async start(onFrames) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      const ctx = new AudioContext();
      const input = ctx.createMediaStreamSource(stream);
      // ScriptProcessor keeps this free of worklet module URLs (the CSP allows 'self' scripts only).
      const node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (ev) =>
        onFrames(ev.inputBuffer.getChannelData(0).slice(), ctx.sampleRate);
      input.connect(node);
      node.connect(ctx.destination);
      return () => {
        node.disconnect();
        input.disconnect();
        for (const t of stream.getTracks()) t.stop();
        void ctx.close();
      };
    },
  };
}

/** The slice of the Web Speech API the composer uses (not in every TypeScript DOM lib). */
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionResultEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0?: { transcript: string } }>;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/**
 * Web Speech dictation for `location: "client"`, or undefined when the browser has none. Some
 * browsers recognise on their vendor's servers; the Gateway picks this engine only when the
 * owner's speech policy says so.
 */
export function webSpeechDictation(
  scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): LocalDictation | undefined {
  const Ctor = (scope.SpeechRecognition ?? scope.webkitSpeechRecognition) as
    | SpeechRecognitionCtor
    | undefined;
  if (typeof Ctor !== "function") return undefined;
  return {
    start({ onSegment, onError, onEnd }) {
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = typeof navigator !== "undefined" ? navigator.language : "en-US";
      let ended = false;
      let stopping: (() => void) | undefined;
      rec.onresult = (ev) => {
        let interim = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          const text = r?.[0]?.transcript ?? "";
          if (r?.isFinal) onSegment({ text, final: true });
          else interim += text;
        }
        onSegment({ text: interim, final: false });
      };
      rec.onerror = (ev) => {
        if (ev.error !== "no-speech" && ev.error !== "aborted") onError(ev.error);
      };
      rec.onend = () => {
        ended = true;
        if (stopping) stopping();
        else onEnd();
      };
      rec.start();
      return {
        stop: () =>
          new Promise<void>((resolve) => {
            if (ended) return resolve();
            const timer = setTimeout(resolve, 3_000);
            stopping = () => {
              clearTimeout(timer);
              resolve();
            };
            rec.stop();
          }),
        cancel: () => {
          rec.onresult = null;
          rec.onerror = null;
          rec.onend = null;
          rec.abort();
        },
      };
    },
  };
}
