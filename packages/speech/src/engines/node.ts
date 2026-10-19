import {
  type AudioChunk,
  type AudioFormat,
  type NodeClient,
  type NodeInvokeResult,
  PsycheError,
  type SpeechCapabilities,
  type SpeechEngine,
  type SynthesizeOptions,
  type TranscribeOptions,
  type Transcript,
  type TranscriptSegment,
  type Voice,
} from "@psyche/protocol";
import { decodeWav, isPcm } from "../audio.ts";
import { AsyncQueue, fromBase64, toBase64 } from "../queue.ts";
import { splitSentences } from "../ssml.ts";
import { sequenceSegments } from "../stream.ts";

/**
 * `SpeechEngine` over the Mac helper's `speech.*` node capabilities (architecture §6; S14,
 * `apps/mac-helper` README "Speech"). The helper owns the engines (SpeechAnalyzer /
 * DictationTranscriber on macOS 26+, on-device SFSpeechRecognizer before that, AVSpeechSynthesizer);
 * this adapter moves audio and segments over the node protocol. Audio travels base64-encoded
 * because node frames are JSON.
 *
 * Push transcription: `speech.transcribe_stream {source: "push", format, locale?, vocabulary?,
 * volatile}` stays pending for the whole stream and emits `{type: "speech.started", streamId}`,
 * then `{type: "speech.partial" | "speech.final", text, startMs, endMs, final, confidence?}`; it
 * resolves with `{streamId, text, segments, language, …}`. Audio goes in with
 * `speech.audio_push {streamId, data, final?}` (≤ 512 KiB decoded each); the last push carries
 * `final: true`. Synthesis: `speech.synthesize {text ≤ 5000, voice?, format}` emits
 * `{type: "speech.audio", seq, data, format}`.
 */
export const NODE_SPEECH_CAPABILITIES = {
  transcribeStream: "speech.transcribe_stream",
  audioPush: "speech.audio_push",
  stop: "speech.stop",
  synthesize: "speech.synthesize",
  voices: "speech.voices",
  status: "speech.status",
} as const;

/** Helper limits (`SpeechLimits` in the Swift helper). */
export const NODE_SPEECH_LIMITS = {
  maxPushBytes: 512 * 1024,
  maxVocabularyEntries: 100,
  maxVocabularyEntryLength: 64,
  maxSynthesisText: 5_000,
  /** Helper accepts 1 s … 10 min per stream. */
  maxDurationMs: 10 * 60 * 1000,
} as const;

export interface NodeSpeechEngineOptions {
  /** Resolves the Mac node to use now, or `undefined` when none is online. */
  node: () => NodeClient | undefined | Promise<NodeClient | undefined>;
  timeoutMs?: number;
  /** Size of each `speech.audio_push` for files (default and maximum 512 KiB). */
  pushBytes?: number;
}

interface HelperEvent {
  type?: string;
  streamId?: string;
  text?: string;
  startMs?: number;
  endMs?: number;
  final?: boolean;
  confidence?: number;
  seq?: number;
  data?: string;
  format?: AudioFormat;
}

interface HelperTranscript {
  text?: string;
  segments?: TranscriptSegment[];
  language?: string;
}

export class NodeSpeechEngine implements SpeechEngine {
  readonly #opts: NodeSpeechEngineOptions;

  constructor(options: NodeSpeechEngineOptions) {
    this.#opts = options;
  }

  async #node(): Promise<NodeClient> {
    const node = await this.#opts.node();
    if (node === undefined) {
      throw new PsycheError("unavailable", "no Mac node is online", { retryable: true });
    }
    return node;
  }

  /** `true` when a node is online and offers `capability`. */
  async available(
    capability: string = NODE_SPEECH_CAPABILITIES.transcribeStream,
  ): Promise<boolean> {
    const node = await this.#opts.node();
    if (node === undefined) return false;
    return (await node.capabilities()).some((c) => c.name === capability);
  }

  async capabilities(): Promise<SpeechCapabilities> {
    const node = await this.#opts.node();
    const names = new Set((await node?.capabilities())?.map((c) => c.name) ?? []);
    return {
      engine: "mac-node",
      streaming: names.has(NODE_SPEECH_CAPABILITIES.transcribeStream),
      synthesis: names.has(NODE_SPEECH_CAPABILITIES.synthesize),
      // Locales come from `speech.status`; the Gateway does not know them up front.
      languages: [],
    };
  }

  async transcribeFile(
    data: Uint8Array,
    format: AudioFormat,
    options: TranscribeOptions = {},
  ): Promise<Transcript> {
    let pcm = data;
    let fmt = format;
    if (format.encoding === "wav") {
      const wav = decodeWav(data);
      if (wav === undefined) throw new PsycheError("invalid_params", "not a PCM WAV file");
      pcm = wav.data;
      fmt = wav.format;
    }
    const size = Math.min(
      this.#opts.pushBytes ?? NODE_SPEECH_LIMITS.maxPushBytes,
      NODE_SPEECH_LIMITS.maxPushBytes,
    );
    const run = this.#run(chunked(pcm, size), fmt, options, false);
    for await (const _ of run.segments) {
      // Finals also arrive in the result; draining keeps the event queue bounded.
    }
    const r = await run.result;
    const t: Transcript = { text: r.text ?? "", segments: (r.segments ?? []).map(segment) };
    if (r.language !== undefined) t.language = r.language;
    return t;
  }

  transcribeStream(
    audio: AsyncIterable<Uint8Array>,
    format: AudioFormat,
    options: TranscribeOptions = {},
  ): AsyncIterable<TranscriptSegment> {
    const run = this.#run(audio, format, options, true);
    run.result.catch(() => {});
    return sequenceSegments(run.segments, options.signal);
  }

  #run(
    audio: AsyncIterable<Uint8Array>,
    format: AudioFormat,
    options: TranscribeOptions,
    volatile: boolean,
  ): { segments: AsyncIterable<TranscriptSegment>; result: Promise<HelperTranscript> } {
    if (
      !isPcm(format) ||
      format.channels > 2 ||
      format.sampleRate < 8_000 ||
      format.sampleRate > 48_000
    ) {
      throw new PsycheError(
        "invalid_params",
        "the Mac node takes 8–48 kHz mono or stereo PCM (pcm_s16le / pcm_f32le)",
      );
    }
    const segments = new AsyncQueue<TranscriptSegment>();
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    if (options.signal?.aborted === true) abort.abort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    let resolveId: (id: string) => void = () => {};
    let rejectId: (e: unknown) => void = () => {};
    const streamId = new Promise<string>((res, rej) => {
      resolveId = res;
      rejectId = rej;
    });
    streamId.catch(() => {});

    const result = (async (): Promise<HelperTranscript> => {
      const node = await this.#node();
      const params: Record<string, unknown> = {
        source: "push",
        format: {
          encoding: format.encoding,
          sampleRate: format.sampleRate,
          channels: format.channels,
        },
        volatile,
        maxDurationMs: NODE_SPEECH_LIMITS.maxDurationMs,
      };
      if (options.language !== undefined) params.locale = options.language;
      const vocab = helperVocabulary(options.vocabulary);
      if (vocab.length > 0) params.vocabulary = vocab;
      const pump = this.#pump(node, audio, streamId, abort);
      // Fail the consumer as soon as a push fails; do not wait for the node to honour the abort.
      void pump.then((err) => {
        if (err !== undefined) segments.fail(err);
      });
      let res: NodeInvokeResult;
      try {
        res = await node.invoke(NODE_SPEECH_CAPABILITIES.transcribeStream, params, {
          // The call stays open for the whole stream; the node registry's default is 60 s.
          ...this.#invokeOptions(abort.signal, NODE_SPEECH_LIMITS.maxDurationMs + 60_000),
          onEvent: (e) => {
            const ev = e.data as HelperEvent | null;
            if (ev?.type === "speech.started" && typeof ev.streamId === "string") {
              resolveId(ev.streamId);
            } else if (ev?.type === "speech.partial" || ev?.type === "speech.final") {
              segments.push(segment(ev));
            }
          },
        });
      } finally {
        // Settles the pump: once the helper call ended, no stream id will arrive.
        rejectId(new PsycheError("internal", "the Mac node ended the stream before it started"));
      }
      if (!res.ok) {
        // Stop pushing now; the pump may be parked waiting for the next audio chunk.
        abort.abort();
        throw toError(res);
      }
      const pumpError = await pump;
      if (pumpError !== undefined && !abort.signal.aborted) throw pumpError;
      return (res.result ?? {}) as HelperTranscript;
    })();

    result.then(
      () => segments.end(),
      (err: unknown) => segments.fail(err),
    );
    void result
      .finally(() => options.signal?.removeEventListener("abort", onAbort))
      .catch(() => {});

    async function* guarded(): AsyncIterable<TranscriptSegment> {
      try {
        yield* segments;
      } finally {
        // Consumer stopped early: cancel the helper stream (node.cancel via the abort signal).
        if (!segments.ended) abort.abort();
      }
    }
    return { segments: guarded(), result };
  }

  /** Pushes audio once the helper announced its stream id; returns the first error, if any. */
  async #pump(
    node: NodeClient,
    audio: AsyncIterable<Uint8Array>,
    streamIdP: Promise<string>,
    abort: AbortController,
  ): Promise<unknown> {
    let streamId: string;
    try {
      streamId = await streamIdP;
    } catch {
      // The helper call ended before `speech.started`; its own result carries the error.
      return undefined;
    }
    try {
      for await (const chunk of audio) {
        if (abort.signal.aborted) return undefined;
        for (const part of chunked1(chunk, NODE_SPEECH_LIMITS.maxPushBytes)) {
          unwrap(
            await node.invoke(
              NODE_SPEECH_CAPABILITIES.audioPush,
              { streamId, data: toBase64(part) },
              this.#invokeOptions(abort.signal),
            ),
          );
        }
      }
      if (abort.signal.aborted) return undefined;
      unwrap(
        await node.invoke(
          NODE_SPEECH_CAPABILITIES.audioPush,
          { streamId, data: "", final: true },
          this.#invokeOptions(abort.signal),
        ),
      );
      return undefined;
    } catch (err) {
      abort.abort();
      return err;
    }
  }

  async *synthesize(text: string, options: SynthesizeOptions = {}): AsyncIterable<AudioChunk> {
    const node = await this.#node();
    const encoding = options.format?.encoding ?? "pcm_s16le";
    if (encoding !== "pcm_s16le" && encoding !== "pcm_f32le") {
      throw new PsycheError(
        "invalid_params",
        "the Mac node synthesizes PCM; transcode for other formats",
      );
    }
    if (options.signal?.aborted === true) return;
    for (const piece of packText(text, NODE_SPEECH_LIMITS.maxSynthesisText)) {
      const chunks = new AsyncQueue<AudioChunk>();
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const params: Record<string, unknown> = { text: piece, format: encoding };
      if (options.voice !== undefined) params.voice = options.voice;
      const done = node
        .invoke(NODE_SPEECH_CAPABILITIES.synthesize, params, {
          ...this.#invokeOptions(abort.signal, SYNTHESIS_TIMEOUT_MS),
          onEvent: (e) => {
            const ev = e.data as HelperEvent | null;
            if (ev?.type !== "speech.audio" || ev.data === undefined || ev.format === undefined)
              return;
            chunks.push({ data: fromBase64(ev.data), format: ev.format });
          },
        })
        .then(
          (res) => (res.ok ? chunks.end() : chunks.fail(toError(res))),
          (err: unknown) => chunks.fail(err),
        );
      let finished = false;
      try {
        yield* chunks;
        finished = true;
      } finally {
        options.signal?.removeEventListener("abort", onAbort);
        if (finished) await done;
        else {
          // Consumer stopped early or the signal fired: cancel the helper call, do not wait for it.
          abort.abort();
          void done.catch(() => {});
        }
      }
      if (isAborted(options.signal)) return;
    }
  }

  async voices(): Promise<Voice[]> {
    const node = await this.#opts.node();
    if (node === undefined) return [];
    const res = await node.invoke(NODE_SPEECH_CAPABILITIES.voices, {}, this.#invokeOptions());
    if (!res.ok) return [];
    const list = (
      res.result as { voices?: { id: string; name: string; language: string }[] } | null
    )?.voices;
    return (list ?? []).map((v) => ({ id: v.id, name: v.name, language: v.language, local: true }));
  }

  #invokeOptions(
    signal?: AbortSignal,
    timeoutMs?: number,
  ): { signal?: AbortSignal; timeoutMs?: number } {
    const o: { signal?: AbortSignal; timeoutMs?: number } = {};
    if (signal !== undefined) o.signal = signal;
    const t = timeoutMs ?? this.#opts.timeoutMs;
    if (t !== undefined) o.timeoutMs = t;
    return o;
  }
}

/** One `speech.synthesize` call renders ≤ 5000 characters; allow it a generous 5 minutes. */
const SYNTHESIS_TIMEOUT_MS = 5 * 60_000;

/** Reads `aborted` through a call so TS does not keep an earlier narrowing. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function segment(ev: HelperEvent | TranscriptSegment): TranscriptSegment {
  const s: TranscriptSegment = {
    text: ev.text ?? "",
    startMs: ev.startMs ?? 0,
    endMs: ev.endMs ?? ev.startMs ?? 0,
    final: ev.final === true,
  };
  if (typeof ev.confidence === "number") s.confidence = ev.confidence;
  return s;
}

/** Vocabulary within the helper's limits (≤ 100 entries of ≤ 64 characters). */
function helperVocabulary(vocab: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of vocab ?? []) {
    const t = raw.trim();
    if (t === "" || t.length > NODE_SPEECH_LIMITS.maxVocabularyEntryLength || out.includes(t))
      continue;
    out.push(t);
    if (out.length === NODE_SPEECH_LIMITS.maxVocabularyEntries) break;
  }
  return out;
}

/** Splits text at sentence boundaries into requests the helper accepts. */
function packText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  for (const s of splitSentences(text, max)) {
    if (cur !== "" && cur.length + 1 + s.length > max) {
      out.push(cur);
      cur = s;
    } else {
      cur = cur === "" ? s : `${cur} ${s}`;
    }
  }
  if (cur !== "") out.push(cur);
  return out;
}

function* chunked1(data: Uint8Array, size: number): Iterable<Uint8Array> {
  for (let off = 0; off < data.byteLength; off += size) yield data.subarray(off, off + size);
}

async function* chunked(data: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  yield* chunked1(data, size);
}

function toError(res: NodeInvokeResult): PsycheError {
  const e = res.error ?? { code: "internal" as const, message: "node invocation failed" };
  const opts: { retryable?: boolean; details?: unknown } = {};
  if (e.retryable !== undefined) opts.retryable = e.retryable;
  if (e.details !== undefined) opts.details = e.details;
  return new PsycheError(e.code, e.message, opts);
}

function unwrap(res: NodeInvokeResult): unknown {
  if (!res.ok) throw toError(res);
  return res.result;
}
