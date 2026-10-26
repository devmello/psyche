import type { AudioFormat } from "@psyche/protocol";
import { pcmToFloat32 } from "../audio.ts";

/**
 * Energy voice-activity detection on the Gateway's conversation PCM (docs/voice/voice-mode-2026.md
 * §4.3). Apple's `SpeechDetector` reports no speech start or end, so Psyche keeps its own
 * detector: RMS on 30 ms frames against an adaptive noise floor (the same scheme as the shell's
 * and whisper.cpp's gates). It reports `start` after sustained speech and `end` after `endMs`
 * of silence, and counts the speech it heard so a cough can be told from a turn.
 */

export interface PcmVadOptions {
  /** Speech when RMS exceeds `noiseFloor × ratio` and `minRms`. */
  ratio?: number;
  minRms?: number;
  /** Sustained speech before `start` (default 120 ms). */
  startMs?: number;
  /** Silence after speech before `end` (default 600 ms, the conversation's pause). */
  endMs?: number;
}

export type PcmVadEvent = "start" | "end";

const FRAME_MS = 30;

export class PcmVad {
  readonly #onEvent: (e: PcmVadEvent) => void;
  #ratio: number;
  #minRms: number;
  #startMs: number;
  #endMs: number;
  #floor = 0.003;
  #carry: number[] = [];
  #carryRate = 0;
  #speechRun = 0;
  #silenceRun = 0;
  #speaking = false;
  /** Speech heard since the last `reset` (ms). */
  speechMs = 0;

  constructor(onEvent: (e: PcmVadEvent) => void, options: PcmVadOptions = {}) {
    this.#onEvent = onEvent;
    this.#ratio = options.ratio ?? 2.5;
    this.#minRms = options.minRms ?? 0.01;
    this.#startMs = options.startMs ?? 120;
    this.#endMs = options.endMs ?? 600;
  }

  get inSpeech(): boolean {
    return this.#speaking;
  }

  set endMs(ms: number) {
    this.#endMs = ms;
  }

  /** Forgets the current utterance and the speech count; the noise floor is kept. */
  reset(): void {
    this.#speechRun = 0;
    this.#silenceRun = 0;
    this.#speaking = false;
    this.speechMs = 0;
  }

  push(pcm: Uint8Array, format: AudioFormat): void {
    const samples = pcmToFloat32(pcm, format);
    const rate = format.sampleRate;
    if (rate !== this.#carryRate) {
      this.#carry = [];
      this.#carryRate = rate;
    }
    const size = Math.max(1, Math.round((rate * FRAME_MS) / 1000));
    let i = 0;
    if (this.#carry.length > 0) {
      while (this.#carry.length < size && i < samples.length) this.#carry.push(samples[i++] ?? 0);
      if (this.#carry.length < size) return;
      this.#frame(Float32Array.from(this.#carry));
      this.#carry = [];
    }
    for (; i + size <= samples.length; i += size) this.#frame(samples.subarray(i, i + size));
    for (; i < samples.length; i++) this.#carry.push(samples[i] ?? 0);
  }

  #frame(f: Float32Array): void {
    let sum = 0;
    for (const v of f) sum += v * v;
    const level = Math.sqrt(sum / f.length);
    const isSpeech = level > Math.max(this.#floor * this.#ratio, this.#minRms);
    if (!isSpeech) {
      this.#floor =
        level < this.#floor ? level * 0.5 + this.#floor * 0.5 : this.#floor * 0.98 + level * 0.02;
      this.#floor = Math.max(this.#floor, 1e-4);
    }
    if (isSpeech) {
      this.#speechRun += FRAME_MS;
      this.#silenceRun = 0;
      if (this.#speaking) this.speechMs += FRAME_MS;
      if (!this.#speaking && this.#speechRun >= this.#startMs) {
        this.#speaking = true;
        this.speechMs += this.#speechRun;
        this.#onEvent("start");
      }
      return;
    }
    if (!this.#speaking) {
      this.#speechRun = 0;
      return;
    }
    this.#silenceRun += FRAME_MS;
    if (this.#silenceRun >= this.#endMs) {
      this.#speaking = false;
      this.#speechRun = 0;
      this.#silenceRun = 0;
      this.#onEvent("end");
    }
  }
}
