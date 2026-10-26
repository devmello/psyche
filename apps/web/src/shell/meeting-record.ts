import type { MeetingRecordingStatus } from "@psyche/protocol";
import { EnergyVad } from "./vad.ts";
import { type AudioSource, microphoneSource, pcmChunkToBase64, toPcm16 } from "./voice.ts";

/**
 * Record meeting, device side (docs/workflows/mail-and-meetings-2026.md §4.6). The Gateway owns
 * the consent gate and the recording; this device only captures the microphone and streams it:
 *
 *   meetings.record.status {}                      → {available, recording, consentLine, …}
 *   meetings.record.start  {consentConfirmed, meetingId?}
 *   meetings.record.push   {seq, audio}            16 kHz mono PCM s16le, ~2 s per chunk
 *   meetings.record.stop   {reason?}
 *
 * with `meetings.recording.updated` events for every device. Nothing opens the microphone before
 * the owner confirmed "I've told everyone"; the recording stops by itself after five minutes of
 * silence, and a failed push stops capture at once so the microphone indicator never outlives it.
 */

export const SILENCE_STOP_MS = 5 * 60_000;
/** One `meetings.record.push` holds about this much audio (512 000 base64 characters allow ~11 s). */
export const CHUNK_SAMPLES = 32_000;

export type MeetingCall = (method: string, params: unknown) => Promise<unknown>;

export type MeetingRecordPhase =
  | { phase: "idle" }
  /** The consent line is on screen; nothing records until it is confirmed. */
  | { phase: "consent"; consentLine: string; meetingId?: string }
  | { phase: "starting" }
  | { phase: "recording"; startedAt: string; meetingId: string | null }
  | { phase: "stopping" };

export interface MeetingRecordView {
  recording: MeetingRecordPhase;
  /** The last recording's notes, from the Gateway: processing, done, needs_permission, failed. */
  notes?: MeetingRecordingStatus["last"];
  /** Why a request failed, as a message id the UI translates. */
  error?: "unavailable" | "micDenied" | "failed";
}

export class MeetingRecorderClient {
  readonly #call: MeetingCall;
  readonly #source: AudioSource;
  readonly #now: () => number;
  readonly #listeners = new Set<(v: MeetingRecordView) => void>();
  #view: MeetingRecordView = { recording: { phase: "idle" } };
  #stopMic: (() => void) | undefined;
  #generation = 0;
  #seq = 0;
  #buffered: Int16Array[] = [];
  #samples = 0;
  #queue: Promise<void> = Promise.resolve();
  #lastVoiceAt = 0;
  #speaking = false;
  #vad: EnergyVad | undefined;
  #stopping: Promise<void> | undefined;

  constructor(options: { call: MeetingCall; source?: AudioSource; now?: () => number }) {
    this.#call = options.call;
    this.#source = options.source ?? microphoneSource();
    this.#now = options.now ?? Date.now;
  }

  get view(): MeetingRecordView {
    return this.#view;
  }

  subscribe(cb: (v: MeetingRecordView) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #set(patch: Partial<MeetingRecordView>): void {
    this.#view = { ...this.#view, ...patch };
    for (const l of [...this.#listeners]) l(this.#view);
  }

  /** Shows the consent line. Refuses (with `unavailable`) when nothing can turn audio into notes. */
  async request(meetingId?: string): Promise<void> {
    if (this.#view.recording.phase !== "idle") return;
    let status: MeetingRecordingStatus;
    try {
      status = (await this.#call("meetings.record.status", {})) as MeetingRecordingStatus;
    } catch {
      this.#set({ error: "failed" });
      return;
    }
    if (status.recording) {
      this.apply(status);
      return;
    }
    if (!status.available) {
      this.#set({ error: "unavailable" });
      return;
    }
    const { error: _e, ...rest } = this.#view;
    this.#view = rest;
    this.#set({
      recording: {
        phase: "consent",
        consentLine: status.consentLine,
        ...(meetingId === undefined ? {} : { meetingId }),
      },
    });
  }

  cancel(): void {
    if (this.#view.recording.phase === "consent") this.#set({ recording: { phase: "idle" } });
  }

  /** "I've told everyone": only now is the microphone opened and the Gateway told to record. */
  async confirm(): Promise<void> {
    const consent = this.#view.recording;
    if (consent.phase !== "consent") return;
    const generation = ++this.#generation;
    this.#set({ recording: { phase: "starting" } });
    try {
      this.#stopMic = await this.#source.start((frames, rate) => this.#onFrames(frames, rate));
    } catch {
      this.#fail("micDenied", generation);
      return;
    }
    if (generation !== this.#generation) {
      this.#releaseMic();
      return;
    }
    this.#seq = 0;
    this.#buffered = [];
    this.#samples = 0;
    this.#queue = Promise.resolve();
    this.#lastVoiceAt = this.#now();
    this.#speaking = false;
    this.#vad = new EnergyVad((e) => {
      this.#speaking = e === "start";
      this.#lastVoiceAt = this.#now();
    });
    try {
      const status = (await this.#call("meetings.record.start", {
        consentConfirmed: true,
        ...(consent.meetingId === undefined ? {} : { meetingId: consent.meetingId }),
      })) as MeetingRecordingStatus;
      if (generation !== this.#generation) return;
      this.apply(status);
    } catch (err) {
      this.#fail(
        (err as { code?: string }).code === "unavailable" ? "unavailable" : "failed",
        generation,
      );
    }
  }

  /** The owner stops the recording (or silence / a failed push did). */
  stop(reason: "stopped" | "silence" | "source_ended" = "stopped"): Promise<void> {
    this.#stopping ??= this.#stop(reason).finally(() => {
      this.#stopping = undefined;
    });
    return this.#stopping;
  }

  async #stop(reason: "stopped" | "silence" | "source_ended"): Promise<void> {
    if (this.#view.recording.phase !== "recording") return;
    this.#set({ recording: { phase: "stopping" } });
    this.#flush();
    this.#releaseMic();
    try {
      await this.#queue;
    } catch {
      // A chunk that failed is why we are here; the Gateway ends what it has.
    }
    try {
      this.apply((await this.#call("meetings.record.stop", { reason })) as MeetingRecordingStatus);
    } catch {
      // Nothing was recorded, or the Gateway already ended it: the next event says which.
      this.#set({ recording: { phase: "idle" } });
    }
  }

  /** A status from the Gateway (the call's answer or `meetings.recording.updated`). */
  apply(status: MeetingRecordingStatus): void {
    const notes = status.last;
    if (status.recording) {
      this.#set({
        recording: {
          phase: "recording",
          startedAt: status.startedAt ?? new Date(this.#now()).toISOString(),
          meetingId: status.meetingId ?? null,
        },
        ...(notes === undefined ? {} : { notes }),
      });
      return;
    }
    // Ended elsewhere (another device stopped it, the Gateway's idle watchdog): let go of the mic.
    this.#releaseMic();
    this.#set({ recording: { phase: "idle" }, ...(notes === undefined ? {} : { notes }) });
  }

  #fail(error: NonNullable<MeetingRecordView["error"]>, generation: number): void {
    if (generation !== this.#generation) return;
    this.#releaseMic();
    this.#set({ recording: { phase: "idle" }, error });
  }

  #releaseMic(): void {
    this.#generation++;
    this.#stopMic?.();
    this.#stopMic = undefined;
    this.#vad = undefined;
  }

  #onFrames(frames: Float32Array, rate: number): void {
    if (this.#view.recording.phase !== "recording" && this.#view.recording.phase !== "starting") {
      return;
    }
    this.#vad?.push(frames, rate);
    const pcm = toPcm16(frames, rate);
    this.#buffered.push(pcm);
    this.#samples += pcm.length;
    if (this.#samples >= CHUNK_SAMPLES) this.#flush();
    if (
      this.#view.recording.phase === "recording" &&
      !this.#speaking &&
      this.#now() - this.#lastVoiceAt >= SILENCE_STOP_MS
    ) {
      void this.stop("silence");
    }
  }

  #flush(): void {
    if (this.#samples === 0) return;
    const out = new Int16Array(this.#samples);
    let at = 0;
    for (const b of this.#buffered) {
      out.set(b, at);
      at += b.length;
    }
    this.#buffered = [];
    this.#samples = 0;
    const seq = this.#seq++;
    const audio = pcmChunkToBase64(out);
    // One push at a time keeps chunks in order; the first failure ends the recording.
    this.#queue = this.#queue.then(async () => {
      try {
        await this.#call("meetings.record.push", { seq, audio });
      } catch (err) {
        void this.stop("source_ended");
        throw err;
      }
    });
    this.#queue.catch(() => undefined);
  }
}
