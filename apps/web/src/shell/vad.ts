import type { AudioSource } from "./voice.ts";

/**
 * Voice activity detection and a shared microphone for voice mode (feature Q5).
 *
 * Voice mode keeps one microphone open for the whole conversation: an energy detector on it ends
 * an utterance after a pause and notices the owner talking over a spoken reply (barge-in), while
 * each utterance's audio goes to the Gateway's dictation session through a tap that first replays
 * the last few hundred milliseconds, so the words that triggered barge-in are not lost.
 *
 * The detector is deliberately simple (RMS on 30 ms frames against an adaptive noise floor), like
 * the Gateway's whisper.cpp gate in `packages/speech`. Barge-in uses a stricter profile because
 * the reply's own sound reaches the microphone; the capture asks for echo cancellation, which
 * removes audio the page itself plays (the Gateway voice) but not every system voice.
 */

export interface VadProfile {
  /** Speech when the frame RMS exceeds `noiseFloor × ratio` and `minRms`. */
  ratio: number;
  minRms: number;
  /** Speech must last this long before `start` fires. */
  startMs: number;
  /** Non-speech this long after speech fires `end`. */
  endMs: number;
}

/** Listening for the owner's turn: quick to start, ends after a 0.9 s pause. */
export const LISTEN_PROFILE: VadProfile = { ratio: 2.5, minRms: 0.01, startMs: 120, endMs: 900 };
/** Talking over a reply: louder and longer before it counts, so the reply does not trigger it. */
export const BARGE_IN_PROFILE: VadProfile = { ratio: 4, minRms: 0.03, startMs: 260, endMs: 900 };

export type VadEvent = "start" | "end";

const FRAME_MS = 30;

export class EnergyVad {
  private profile: VadProfile;
  private noiseFloor = 0.003;
  private carry: number[] = [];
  private carryRate = 0;
  private speechMs = 0;
  private silenceMs = 0;
  private speaking = false;
  private readonly onEvent: (e: VadEvent) => void;

  constructor(onEvent: (e: VadEvent) => void, profile: VadProfile = LISTEN_PROFILE) {
    this.onEvent = onEvent;
    this.profile = profile;
  }

  /** Switches thresholds (listening ↔ barge-in) and forgets the current utterance. */
  setProfile(profile: VadProfile): void {
    this.profile = profile;
    this.reset();
  }

  /** Forgets the current utterance; the noise floor is kept. */
  reset(): void {
    this.speechMs = 0;
    this.silenceMs = 0;
    this.speaking = false;
  }

  get inSpeech(): boolean {
    return this.speaking;
  }

  push(frames: Float32Array, sampleRate: number): void {
    if (sampleRate !== this.carryRate) {
      this.carry = [];
      this.carryRate = sampleRate;
    }
    const size = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
    let i = 0;
    if (this.carry.length > 0) {
      while (this.carry.length < size && i < frames.length) this.carry.push(frames[i++] ?? 0);
      if (this.carry.length < size) return;
      this.frame(Float32Array.from(this.carry));
      this.carry = [];
    }
    for (; i + size <= frames.length; i += size) this.frame(frames.subarray(i, i + size));
    for (; i < frames.length; i++) this.carry.push(frames[i] ?? 0);
  }

  private frame(f: Float32Array): void {
    let sum = 0;
    for (const v of f) sum += v * v;
    const rms = Math.sqrt(sum / f.length);
    const p = this.profile;
    const isSpeech = rms > Math.max(this.noiseFloor * p.ratio, p.minRms);
    if (!isSpeech) {
      // The floor follows quiet frames quickly down and slowly up.
      this.noiseFloor =
        rms < this.noiseFloor
          ? rms * 0.5 + this.noiseFloor * 0.5
          : this.noiseFloor * 0.98 + rms * 0.02;
      this.noiseFloor = Math.max(this.noiseFloor, 1e-4);
    }
    if (isSpeech) {
      this.speechMs += FRAME_MS;
      this.silenceMs = 0;
      if (!this.speaking && this.speechMs >= p.startMs) {
        this.speaking = true;
        this.onEvent("start");
      }
    } else {
      if (!this.speaking) this.speechMs = 0;
      else {
        this.silenceMs += FRAME_MS;
        if (this.silenceMs >= p.endMs) {
          this.speaking = false;
          this.speechMs = 0;
          this.silenceMs = 0;
          this.onEvent("end");
        }
      }
    }
  }
}

/**
 * One open microphone shared by the detector and the dictation taps. `tap()` returns an
 * `AudioSource` for `VoiceCapture`: on start it replays the last `prerollMs` of audio, then
 * streams live frames until its stop function runs.
 */
export class SharedMic {
  private readonly source: AudioSource;
  private readonly prerollMs: number;
  private stopSource: (() => void) | undefined;
  private readonly listeners = new Set<(frames: Float32Array, rate: number) => void>();
  private ring: { frames: Float32Array; rate: number }[] = [];
  private ringMs = 0;

  constructor(source: AudioSource, prerollMs = 600) {
    this.source = source;
    this.prerollMs = prerollMs;
  }

  get open(): boolean {
    return this.stopSource !== undefined;
  }

  /** Opens the microphone; `onFrames` sees every frame (the detector). */
  async start(onFrames: (frames: Float32Array, rate: number) => void): Promise<void> {
    if (this.stopSource) return;
    this.stopSource = await this.source.start((frames, rate) => {
      this.remember(frames, rate);
      onFrames(frames, rate);
      for (const l of [...this.listeners]) l(frames, rate);
    });
  }

  stop(): void {
    this.stopSource?.();
    this.stopSource = undefined;
    this.listeners.clear();
    this.ring = [];
    this.ringMs = 0;
  }

  /** Drops the replay buffer (after a reply, so it never reaches the next utterance). */
  clearPreroll(): void {
    this.ring = [];
    this.ringMs = 0;
  }

  tap(): AudioSource {
    return {
      start: async (onFrames) => {
        for (const r of this.ring) onFrames(r.frames, r.rate);
        this.listeners.add(onFrames);
        return () => {
          this.listeners.delete(onFrames);
        };
      },
    };
  }

  private remember(frames: Float32Array, rate: number): void {
    this.ring.push({ frames, rate });
    this.ringMs += (frames.length / rate) * 1000;
    while (this.ring.length > 1 && this.ringMs - this.durationMs(this.ring[0]) >= this.prerollMs) {
      this.ringMs -= this.durationMs(this.ring.shift());
    }
  }

  private durationMs(r: { frames: Float32Array; rate: number } | undefined): number {
    return r === undefined ? 0 : (r.frames.length / r.rate) * 1000;
  }
}
