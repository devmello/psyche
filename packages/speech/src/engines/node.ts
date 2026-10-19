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
import { AsyncQueue, fromBase64, toBase64 } from "../queue.ts";
import { sequenceSegments } from "../stream.ts";

/**
 * `SpeechEngine` over the Mac helper's `speech.*` node capabilities (architecture §6). The
 * helper owns the engines (SpeechAnalyzer / SpeechTranscriber / DictationTranscriber on macOS
 * 26+, FluidAudio Parakeet or WhisperKit on 14–15, AVSpeechSynthesizer); this adapter only
 * moves audio and segments over the node protocol. Audio travels base64-encoded because node
 * frames are JSON. The capability shapes below are S17's proposal to S14 (docs/status/s17.md).
 */
export const NODE_SPEECH_CAPABILITIES = {
  /** `{audio, format, language?, vocabulary?}` → `Transcript`. */
  transcribe: "speech.transcribe",
  /**
   * `{streamId, format, language?, vocabulary?}`. Stays pending for the whole stream, emitting
   * `{segment: TranscriptSegment}` events; resolves with the final `Transcript` after
   * `speech.stream.finish`. Aborting the invocation cancels the stream.
   */
  streamOpen: "speech.stream.open",
  /** `{streamId, audio}` → `{}`. Chunks for one stream arrive in order. */
  streamPush: "speech.stream.push",
  /** `{streamId}` → `{}`. Flushes; the open invocation resolves after its last final. */
  streamFinish: "speech.stream.finish",
  /** `{text, voice?, format?}`; emits `{audio, format}` chunk events, resolves `{format}`. */
  synthesize: "speech.synthesize",
  /** `{}` → `{voices: Voice[]}`. */
  voices: "speech.voices",
} as const;

export interface NodeSpeechEngineOptions {
  /** Resolves the Mac node to use now, or `undefined` when none is online. */
  node: () => NodeClient | undefined | Promise<NodeClient | undefined>;
  /** Stream ids are unique per Gateway; injectable for tests. */
  newStreamId?: () => string;
  timeoutMs?: number;
}

interface SegmentEvent {
  segment: TranscriptSegment;
}
interface AudioEvent {
  audio: string;
  format: AudioFormat;
}

export class NodeSpeechEngine implements SpeechEngine {
  readonly #opts: NodeSpeechEngineOptions;
  #counter = 0;

  constructor(options: NodeSpeechEngineOptions) {
    this.#opts = options;
  }

  async #node(): Promise<NodeClient> {
    const node = await this.#opts.node();
    if (node === undefined)
      throw new PsycheError("unavailable", "no Mac node is online", { retryable: true });
    return node;
  }

  /** `true` when a node is online and offers `speech.transcribe`. */
  async available(capability: string = NODE_SPEECH_CAPABILITIES.transcribe): Promise<boolean> {
    const node = await this.#opts.node();
    if (node === undefined) return false;
    const caps = await node.capabilities();
    return caps.some((c) => c.name === capability);
  }

  async capabilities(): Promise<SpeechCapabilities> {
    const node = await this.#opts.node();
    const names = new Set((await node?.capabilities())?.map((c) => c.name) ?? []);
    return {
      engine: "mac-node",
      streaming: names.has(NODE_SPEECH_CAPABILITIES.streamOpen),
      synthesis: names.has(NODE_SPEECH_CAPABILITIES.synthesize),
      // The helper reports locales through `speech.voices` / SpeechTranscriber.supportedLocales;
      // the Gateway does not know them up front.
      languages: [],
    };
  }

  async transcribeFile(
    data: Uint8Array,
    format: AudioFormat,
    options: TranscribeOptions = {},
  ): Promise<Transcript> {
    const node = await this.#node();
    const res = await node.invoke(
      NODE_SPEECH_CAPABILITIES.transcribe,
      { audio: toBase64(data), format, ...transcribeParams(options) },
      this.#invokeOptions(options.signal),
    );
    return unwrap(res) as Transcript;
  }

  async *transcribeStream(
    audio: AsyncIterable<Uint8Array>,
    format: AudioFormat,
    options: TranscribeOptions = {},
  ): AsyncIterable<TranscriptSegment> {
    const node = await this.#node();
    const streamId =
      this.#opts.newStreamId?.() ?? `sst_${Date.now().toString(36)}_${++this.#counter}`;
    const segments = new AsyncQueue<TranscriptSegment>();
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const open = node
      .invoke(
        NODE_SPEECH_CAPABILITIES.streamOpen,
        { streamId, format, ...transcribeParams(options) },
        {
          ...this.#invokeOptions(abort.signal),
          onEvent: (e) => {
            const seg = (e.data as Partial<SegmentEvent> | null)?.segment;
            if (seg !== undefined) segments.push(seg);
          },
        },
      )
      .then(
        (res) => {
          if (res.ok) segments.end();
          else segments.fail(toError(res));
        },
        (err: unknown) => segments.fail(err),
      );

    const pump = (async () => {
      try {
        for await (const chunk of audio) {
          if (abort.signal.aborted || segments.ended) return;
          unwrap(
            await node.invoke(
              NODE_SPEECH_CAPABILITIES.streamPush,
              { streamId, audio: toBase64(chunk) },
              this.#invokeOptions(abort.signal),
            ),
          );
        }
        if (abort.signal.aborted) return;
        unwrap(
          await node.invoke(
            NODE_SPEECH_CAPABILITIES.streamFinish,
            { streamId },
            this.#invokeOptions(abort.signal),
          ),
        );
      } catch (err) {
        segments.fail(err);
        abort.abort();
      }
    })();

    try {
      yield* sequenceSegments(segments, abort.signal);
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (!segments.ended) abort.abort();
      await Promise.allSettled([open, pump]);
    }
  }

  async *synthesize(text: string, options: SynthesizeOptions = {}): AsyncIterable<AudioChunk> {
    const node = await this.#node();
    const chunks = new AsyncQueue<AudioChunk>();
    const params: Record<string, unknown> = { text };
    if (options.voice !== undefined) params.voice = options.voice;
    if (options.format !== undefined) params.format = options.format;
    let emitted = false;
    const done = node
      .invoke(NODE_SPEECH_CAPABILITIES.synthesize, params, {
        ...this.#invokeOptions(options.signal),
        onEvent: (e) => {
          const ev = e.data as Partial<AudioEvent> | null;
          if (ev?.audio === undefined || ev.format === undefined) return;
          emitted = true;
          chunks.push({ data: fromBase64(ev.audio), format: ev.format });
        },
      })
      .then(
        (res) => {
          if (!res.ok) return chunks.fail(toError(res));
          // A helper may return the whole clip in the result instead of streaming it.
          const r = res.result as Partial<AudioEvent> | null;
          if (!emitted && r?.audio !== undefined && r.format !== undefined) {
            chunks.push({ data: fromBase64(r.audio), format: r.format });
          }
          chunks.end();
        },
        (err: unknown) => chunks.fail(err),
      );
    try {
      yield* chunks;
    } finally {
      await done;
    }
  }

  async voices(): Promise<Voice[]> {
    const node = await this.#opts.node();
    if (node === undefined) return [];
    const res = await node.invoke(NODE_SPEECH_CAPABILITIES.voices, {}, this.#invokeOptions());
    if (!res.ok) return [];
    return ((res.result as { voices?: Voice[] } | null)?.voices ?? []).map((v) => ({
      ...v,
      local: true,
    }));
  }

  #invokeOptions(signal?: AbortSignal): { signal?: AbortSignal; timeoutMs?: number } {
    const o: { signal?: AbortSignal; timeoutMs?: number } = {};
    if (signal !== undefined) o.signal = signal;
    if (this.#opts.timeoutMs !== undefined) o.timeoutMs = this.#opts.timeoutMs;
    return o;
  }
}

function transcribeParams(options: TranscribeOptions): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (options.language !== undefined) p.language = options.language;
  if (options.vocabulary !== undefined && options.vocabulary.length > 0) {
    p.vocabulary = options.vocabulary;
  }
  return p;
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
