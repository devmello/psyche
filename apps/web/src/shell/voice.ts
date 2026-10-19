import { toBase64Url } from "../client/encoding.ts";

/**
 * Composer dictation capture (feature Q1 UI). The shell only captures audio and streams it to
 * the Gateway's `voice.*` methods; engines live in S14 (helper) and S17 (Gateway). Method names
 * follow S17's plan (`voice.start` / `voice.push` / `voice.stop` / `voice.cancel`, events
 * `voice.partial` / `voice.final`); until that protocol PR lands the Gateway answers
 * `unknown_method` and the mic button says dictation is unavailable.
 *
 * Audio: mono PCM s16le at 16 kHz in ~100 ms chunks, base64url in `chunk`.
 */

export const VOICE_SAMPLE_RATE = 16_000;

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

export function pcmChunkToBase64Url(pcm: Int16Array): string {
  return toBase64Url(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
}

export type VoiceMode = "push_to_talk" | "toggle";

export type VoiceCall = (method: string, params: unknown) => Promise<unknown>;

export interface AudioSource {
  /** Starts delivering Float32 frames; returns a stop function. */
  start(onFrames: (frames: Float32Array, sampleRate: number) => void): Promise<() => void>;
}

export type VoiceState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "listening"; streamId: string; partial: string }
  | { phase: "finishing"; streamId: string; partial: string }
  | { phase: "unavailable"; reason: string };

export class VoiceCapture {
  private state: VoiceState = { phase: "idle" };
  private stopAudio: (() => void) | undefined;
  private seq = 0;
  private buffered: Int16Array[] = [];
  private bufferedSamples = 0;
  private readonly call: VoiceCall;
  private readonly source: AudioSource;
  private readonly onState: (s: VoiceState) => void;

  constructor(call: VoiceCall, source: AudioSource, onState: (s: VoiceState) => void) {
    this.call = call;
    this.source = source;
    this.onState = onState;
  }

  getState(): VoiceState {
    return this.state;
  }

  private set(s: VoiceState): void {
    this.state = s;
    this.onState(s);
  }

  async start(mode: VoiceMode, threadId?: string): Promise<void> {
    if (this.state.phase === "listening" || this.state.phase === "starting") return;
    this.set({ phase: "starting" });
    let streamId: string;
    try {
      const res = (await this.call("voice.start", {
        mode,
        sampleRate: VOICE_SAMPLE_RATE,
        encoding: "pcm_s16le",
        ...(threadId ? { threadId } : {}),
      })) as { streamId?: unknown };
      if (typeof res?.streamId !== "string") throw new Error("bad voice.start result");
      streamId = res.streamId;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      this.set({
        phase: "unavailable",
        reason:
          code === "unknown_method" || code === "not_implemented"
            ? "Dictation needs the Gateway's voice service, which isn't available yet."
            : "Psyche couldn't start dictation.",
      });
      return;
    }
    this.seq = 0;
    this.set({ phase: "listening", streamId, partial: "" });
    try {
      this.stopAudio = await this.source.start((frames, rate) => this.onFrames(frames, rate));
    } catch {
      void this.call("voice.cancel", { streamId }).catch(() => undefined);
      this.set({ phase: "unavailable", reason: "Psyche can't use the microphone." });
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
    if (this.bufferedSamples === 0) return;
    const out = new Int16Array(this.bufferedSamples);
    let o = 0;
    for (const b of this.buffered) {
      out.set(b, o);
      o += b.length;
    }
    this.buffered = [];
    this.bufferedSamples = 0;
    const { streamId } = this.state;
    void this.call("voice.push", {
      streamId,
      seq: this.seq++,
      chunk: pcmChunkToBase64Url(out),
    }).catch(() => undefined);
  }

  /** Partial transcripts from `voice.partial` events. */
  onPartial(streamId: string, text: string): void {
    if (this.state.phase === "listening" && this.state.streamId === streamId)
      this.set({ ...this.state, partial: text });
  }

  /** Stops capture and returns the final text (empty when nothing was recognised). */
  async stop(): Promise<string> {
    if (this.state.phase !== "listening") return "";
    this.stopAudio?.();
    this.stopAudio = undefined;
    this.set({ phase: "finishing", streamId: this.state.streamId, partial: this.state.partial });
    this.flush();
    const { streamId, partial } = this.state;
    try {
      const res = (await this.call("voice.stop", { streamId })) as { text?: unknown };
      this.set({ phase: "idle" });
      return typeof res?.text === "string" ? res.text : partial;
    } catch {
      this.set({ phase: "idle" });
      return partial;
    }
  }

  cancel(): void {
    if (this.state.phase === "listening" || this.state.phase === "finishing") {
      void this.call("voice.cancel", { streamId: this.state.streamId }).catch(() => undefined);
    }
    this.stopAudio?.();
    this.stopAudio = undefined;
    this.buffered = [];
    this.bufferedSamples = 0;
    this.set({ phase: "idle" });
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
