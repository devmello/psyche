import {
  type AudioFormat,
  PsycheError,
  type Transcript,
  type TranscriptSegment,
} from "@psyche/protocol";
import { bytesPerSample, isPcm } from "./audio.ts";
import type { EngineLocation, SpeechCaller, SpeechEngineSelector } from "./policy.ts";
import { AsyncQueue, fromBase64 } from "./queue.ts";
import { SegmentSequencer } from "./stream.ts";
import { mergeVocabulary } from "./vocabulary.ts";

/**
 * Composer dictation over the Gateway (feature Q1; `voice.*` in architecture §11). The desktop
 * and web clients capture audio and call:
 *
 *   voice.start {format, language?, vocabulary?, threadId?} → {sessionId, location, engine}
 *   voice.push  {sessionId, seq, audio (base64 PCM)}        → {}
 *   voice.stop  {sessionId}                                  → {transcript}
 *   voice.cancel {sessionId}                                 → {}
 *
 * and receive `voice.segment {sessionId, segment}` (partials and finals, in order) and
 * `voice.ended {sessionId, reason}`. When the policy picks a client engine (Web Speech),
 * `start` returns `location: "client"` and no session: the web client dictates locally.
 *
 * Sessions belong to the device that started them; chunks must arrive in `seq` order; sessions
 * end after `idleTimeoutMs` without audio or at `maxSessionMs`. Custom vocabulary is the
 * session default (agent name, contacts, recent topics) merged with the request's terms.
 * These shapes are proposed to `packages/protocol` (docs/status/s17.md).
 */

export interface VoiceStartParams {
  format: AudioFormat;
  language?: string;
  vocabulary?: string[];
  threadId?: string;
}

export interface VoiceStartResult {
  sessionId: string | null;
  location: EngineLocation;
  engine: string;
}

export interface VoicePushParams {
  sessionId: string;
  seq: number;
  /** Base64 raw PCM in the session's format. */
  audio: string;
}

export type VoiceEndReason = "stopped" | "cancelled" | "timeout" | "error";

export type VoiceEvent =
  | { event: "voice.segment"; payload: { sessionId: string; segment: TranscriptSegment } }
  | {
      event: "voice.ended";
      payload: {
        sessionId: string;
        reason: VoiceEndReason;
        error?: { code: string; message: string };
      };
    };

export interface VoiceCallContext {
  deviceId: string;
  caller: SpeechCaller;
}

export interface VoiceSessionOptions {
  selector: SpeechEngineSelector;
  /** Session-default vocabulary (agent name, contacts, recent topics). */
  vocabulary?: () => Promise<string[]> | string[];
  /** Delivers events to the session's device (the Gateway's event bus). */
  emit: (deviceId: string, event: VoiceEvent) => void;
  newId?: () => string;
  idleTimeoutMs?: number;
  maxSessionMs?: number;
  /** Concurrent sessions per device. */
  maxPerDevice?: number;
}

/** One base64 chunk may carry at most 1 s of 48 kHz stereo f32 (384 KB). */
export const VOICE_MAX_CHUNK_BYTES = 384_000;

interface Session {
  id: string;
  deviceId: string;
  format: AudioFormat;
  audio: AsyncQueue<Uint8Array>;
  abort: AbortController;
  nextSeq: number;
  receivedBytes: number;
  maxBytes: number;
  idle: ReturnType<typeof setTimeout> | undefined;
  hardStop: ReturnType<typeof setTimeout>;
  ended: VoiceEndReason | undefined;
  done: Promise<Transcript>;
}

export class VoiceSessionManager {
  readonly #opts: VoiceSessionOptions;
  readonly #sessions = new Map<string, Session>();
  #counter = 0;

  constructor(options: VoiceSessionOptions) {
    this.#opts = options;
  }

  get active(): number {
    return this.#sessions.size;
  }

  async start(params: VoiceStartParams, ctx: VoiceCallContext): Promise<VoiceStartResult> {
    const sel = await this.#opts.selector.select({ purpose: "dictation", caller: ctx.caller });
    if (sel.location === "client" || sel.engine === undefined) {
      return { sessionId: null, location: "client", engine: sel.id };
    }
    if (!isPcm(params.format) || params.format.channels < 1 || params.format.channels > 2) {
      throw new PsycheError("invalid_params", "dictation audio must be mono or stereo raw PCM");
    }
    if (params.format.sampleRate < 8_000 || params.format.sampleRate > 48_000) {
      throw new PsycheError("invalid_params", "sample rate must be 8–48 kHz");
    }
    const mine = [...this.#sessions.values()].filter((s) => s.deviceId === ctx.deviceId);
    if (mine.length >= (this.#opts.maxPerDevice ?? 2)) {
      throw new PsycheError("rate_limited", "too many dictation sessions on this device", {
        retryable: true,
      });
    }
    const defaults = (await this.#opts.vocabulary?.()) ?? [];
    const vocabulary = mergeVocabulary(params.vocabulary, defaults);
    const id = this.#opts.newId?.() ?? `vs_${Date.now().toString(36)}_${++this.#counter}`;
    const maxMs = this.#opts.maxSessionMs ?? 10 * 60_000;
    const bytesPerMs =
      (params.format.sampleRate * params.format.channels * bytesPerSample(params.format)) / 1000;
    const audio = new AsyncQueue<Uint8Array>();
    const abort = new AbortController();
    const session: Session = {
      id,
      deviceId: ctx.deviceId,
      format: params.format,
      audio,
      abort,
      nextSeq: 0,
      receivedBytes: 0,
      maxBytes: Math.ceil(maxMs * bytesPerMs),
      idle: undefined,
      hardStop: setTimeout(() => this.#finish(session, "timeout"), maxMs),
      ended: undefined,
      done: Promise.resolve({ text: "", segments: [] }),
    };
    const options: { signal: AbortSignal; language?: string; vocabulary?: string[] } = {
      signal: abort.signal,
    };
    if (params.language !== undefined) options.language = params.language;
    if (vocabulary.length > 0) options.vocabulary = vocabulary;
    const stream = sel.engine.transcribeStream(audio, params.format, options);
    session.done = this.#consume(session, stream, params.language);
    // Unhandled rejections are reported through `voice.ended`; `stop` re-raises them.
    session.done.catch(() => {});
    this.#sessions.set(id, session);
    this.#touch(session);
    return { sessionId: id, location: sel.location, engine: sel.id };
  }

  push(params: VoicePushParams, ctx: VoiceCallContext): void {
    const s = this.#own(params.sessionId, ctx);
    if (s.ended !== undefined) throw new PsycheError("conflict", "dictation session has ended");
    if (params.seq !== s.nextSeq) {
      throw new PsycheError("invalid_params", `expected chunk ${s.nextSeq}, got ${params.seq}`);
    }
    const data = fromBase64(params.audio);
    if (data.byteLength > VOICE_MAX_CHUNK_BYTES) {
      throw new PsycheError("invalid_params", "audio chunk too large");
    }
    s.nextSeq++;
    s.receivedBytes += data.byteLength;
    if (s.receivedBytes > s.maxBytes) {
      this.#finish(s, "timeout");
      throw new PsycheError("invalid_params", "dictation session reached its maximum length");
    }
    s.audio.push(data);
    this.#touch(s);
  }

  /** Ends the audio and waits for the last final. */
  async stop(sessionId: string, ctx: VoiceCallContext): Promise<Transcript> {
    const s = this.#own(sessionId, ctx);
    this.#finish(s, "stopped");
    return s.done;
  }

  cancel(sessionId: string, ctx: VoiceCallContext): void {
    const s = this.#own(sessionId, ctx);
    this.#finish(s, "cancelled");
  }

  /** Cancels every session of a device (disconnect) or all of them (shutdown). */
  cancelAll(deviceId?: string): void {
    for (const s of [...this.#sessions.values()]) {
      if (deviceId === undefined || s.deviceId === deviceId) this.#finish(s, "cancelled");
    }
  }

  #own(sessionId: string, ctx: VoiceCallContext): Session {
    const s = this.#sessions.get(sessionId);
    // Another device's session id is indistinguishable from an unknown one.
    if (s === undefined || s.deviceId !== ctx.deviceId) {
      throw new PsycheError("not_found", `no dictation session ${sessionId}`);
    }
    return s;
  }

  #touch(s: Session): void {
    if (s.idle !== undefined) clearTimeout(s.idle);
    s.idle = setTimeout(() => this.#finish(s, "timeout"), this.#opts.idleTimeoutMs ?? 30_000);
  }

  #finish(s: Session, reason: VoiceEndReason): void {
    if (s.ended !== undefined) return;
    s.ended = reason;
    if (s.idle !== undefined) clearTimeout(s.idle);
    clearTimeout(s.hardStop);
    // `stopped` and `timeout` flush: the engine finalizes what it heard. `cancelled` drops it.
    if (reason === "cancelled") s.abort.abort();
    s.audio.end();
  }

  async #consume(
    s: Session,
    stream: AsyncIterable<TranscriptSegment>,
    language: string | undefined,
  ): Promise<Transcript> {
    const seq = new SegmentSequencer();
    try {
      for await (const segment of stream) {
        if (s.abort.signal.aborted) break;
        for (const out of seq.push(segment)) {
          this.#opts.emit(s.deviceId, {
            event: "voice.segment",
            payload: { sessionId: s.id, segment: out },
          });
        }
      }
      if (!s.abort.signal.aborted) {
        for (const out of seq.finish()) {
          this.#opts.emit(s.deviceId, {
            event: "voice.segment",
            payload: { sessionId: s.id, segment: out },
          });
        }
      }
      this.#end(s, s.ended ?? "stopped");
      return seq.transcript(language);
    } catch (err) {
      const e =
        err instanceof PsycheError
          ? { code: err.code, message: err.message }
          : { code: "internal", message: "transcription failed" };
      this.#end(s, s.abort.signal.aborted ? "cancelled" : "error", e);
      throw err;
    }
  }

  #end(s: Session, reason: VoiceEndReason, error?: { code: string; message: string }): void {
    if (!this.#sessions.has(s.id)) return;
    this.#sessions.delete(s.id);
    s.ended ??= reason;
    if (s.idle !== undefined) clearTimeout(s.idle);
    clearTimeout(s.hardStop);
    s.audio.end();
    const payload: Extract<VoiceEvent, { event: "voice.ended" }>["payload"] = {
      sessionId: s.id,
      reason,
    };
    if (error !== undefined) payload.error = error;
    this.#opts.emit(s.deviceId, { event: "voice.ended", payload });
  }
}
