import { access, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AudioFormat,
  PsycheError,
  type SpeechCapabilities,
  type SpeechEngine,
  type TranscribeOptions,
  type Transcript,
  type TranscriptSegment,
} from "@psyche/protocol";
import {
  assertPcmFormat,
  bytesPerSample,
  concatBytes,
  decodeWav,
  encodeWav,
  float32ToS16le,
  isPcm,
  PCM_16K_MONO,
  pcmToFloat32,
  rms,
  StreamingResampler,
  toPcm16kMono,
} from "../audio.ts";
import { assertOk, findBinary, LocalProcessRunner, type ProcessRunner } from "../process.ts";
import { joinSegments, SegmentSequencer, sequenceSegments } from "../stream.ts";
import { whisperPrompt } from "../vocabulary.ts";
import type { PathTranscribeOptions, PathTranscriber, PathTranscript } from "./node.ts";

/**
 * whisper.cpp on the Gateway host (ADR-014; the server and Linux path). Two backends:
 *
 * - `WhisperCliBackend` spawns the upstream `whisper-cli` per request (`brew install whisper-cpp`
 *   or a source build). No native addon in this package; the model is reloaded per call, which
 *   is fine for tiny/base and for voice notes.
 * - `WhisperServerBackend` talks to a loopback `whisper-server` that keeps the model loaded,
 *   for low-latency partials with larger models.
 *
 * Streaming (`transcribeStream`) is VAD-gated chunked inference: an energy VAD splits the audio
 * into utterances; while an utterance grows, the engine re-transcribes it every
 * `partialIntervalMs` and emits a volatile partial; when it ends (silence or max length) the
 * engine transcribes it once more and emits the final. Custom vocabulary and the previous final
 * go into whisper's initial `--prompt`.
 */

export interface WhisperSegment {
  text: string;
  startMs: number;
  endMs: number;
}

export interface WhisperRequest {
  /** 16 kHz mono s16le PCM. */
  pcm: Uint8Array;
  language?: string;
  prompt?: string;
  /** Let whisper.cpp's Silero VAD skip silence (file transcription). */
  vad?: boolean;
  /**
   * Encoder frames to run (whisper's `audio_ctx`; 1500 = the full 30 s window). Short dictation
   * utterances need far fewer: `audioCtxFor` sizes it to the audio, which roughly halves the time
   * per request on a CPU.
   */
  audioCtx?: number;
  /**
   * No temperature fallback (one greedy pass). With a fitted `audioCtx` the fallback is what
   * turns a hard utterance into a slow hallucination, so live dictation turns it off.
   */
  noFallback?: boolean;
  signal?: AbortSignal;
}

/** Whisper's encoder runs 50 frames per second of audio over a fixed 30 s window. */
const FULL_AUDIO_CTX = 1500;

/** `audio_ctx` for `pcmBytes` of 16 kHz mono s16le: the audio's frames plus 2.5 s of head room. */
export function audioCtxFor(pcmBytes: number): number {
  const frames = Math.ceil((pcmBytes / 32_000) * 50) + 128;
  return Math.min(FULL_AUDIO_CTX, Math.max(256, Math.ceil(frames / 64) * 64));
}

export interface WhisperBackend {
  readonly name: string;
  available(): Promise<boolean>;
  transcribe(request: WhisperRequest): Promise<WhisperSegment[]>;
  /** Gets ready for a request that is about to come (loads the model); optional. */
  warm?(): Promise<void>;
}

/** Bracketed non-speech tags whisper emits on silence or noise: `[BLANK_AUDIO]`, `(music)`. */
const NON_SPEECH = /^\s*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*)\s*$/;

export function cleanWhisperText(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return NON_SPEECH.test(t) ? "" : t;
}

// --- whisper-cli --------------------------------------------------------------------------------

export interface WhisperCliOptions {
  modelPath: string;
  /** Binary name or path; default `whisper-cli` on PATH. */
  binary?: string;
  vadModelPath?: string;
  threads?: number;
  runner?: ProcessRunner;
  timeoutMs?: number;
}

interface WhisperCliJson {
  transcription?: { offsets?: { from?: number; to?: number }; text?: string }[];
}

export class WhisperCliBackend implements WhisperBackend {
  readonly name = "whisper-cli";
  readonly #opts: WhisperCliOptions;
  readonly #runner: ProcessRunner;

  constructor(options: WhisperCliOptions) {
    this.#opts = options;
    this.#runner = options.runner ?? new LocalProcessRunner();
  }

  async available(): Promise<boolean> {
    if ((await findBinary(this.#opts.binary ?? "whisper-cli")) === undefined) return false;
    return access(this.#opts.modelPath).then(
      () => true,
      () => false,
    );
  }

  /** argv for one request. */
  argv(wavPath: string, request: Omit<WhisperRequest, "pcm" | "signal">): string[] {
    const o = this.#opts;
    const argv = [o.binary ?? "whisper-cli", "-m", o.modelPath, "-f", wavPath];
    argv.push("-l", request.language ?? "en");
    argv.push("-t", String(o.threads ?? 4));
    argv.push("-oj", "-of", "-", "-np");
    if (request.prompt !== undefined && request.prompt !== "")
      argv.push("--prompt", request.prompt);
    if (request.vad === true && o.vadModelPath !== undefined) {
      argv.push("--vad", "-vm", o.vadModelPath);
    }
    if (request.audioCtx !== undefined) argv.push("-ac", String(request.audioCtx));
    if (request.noFallback === true) argv.push("-nf");
    return argv;
  }

  async transcribe(request: WhisperRequest): Promise<WhisperSegment[]> {
    const dir = await mkdtemp(join(tmpdir(), "psyche-whisper-"));
    try {
      const wav = join(dir, "in.wav");
      await writeFile(wav, encodeWav(request.pcm, PCM_16K_MONO), { mode: 0o600 });
      const run = { argv: this.argv(wav, request), timeoutMs: this.#opts.timeoutMs ?? 300_000 };
      const res = assertOk(
        await this.#runner.run(
          request.signal === undefined ? run : { ...run, signal: request.signal },
        ),
        "whisper-cli",
      );
      return parseWhisperCliJson(new TextDecoder().decode(res.stdout));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export function parseWhisperCliJson(text: string): WhisperSegment[] {
  // `-of -` prints the JSON document to stdout; tolerate stray log lines before it.
  const start = text.indexOf("{");
  if (start < 0) throw new PsycheError("internal", "whisper-cli printed no JSON");
  let doc: WhisperCliJson;
  try {
    doc = JSON.parse(text.slice(start)) as WhisperCliJson;
  } catch (err) {
    throw new PsycheError("internal", "whisper-cli printed invalid JSON", { cause: err });
  }
  return (doc.transcription ?? [])
    .map((s) => ({
      text: cleanWhisperText(s.text ?? ""),
      startMs: s.offsets?.from ?? 0,
      endMs: s.offsets?.to ?? 0,
    }))
    .filter((s) => s.text !== "");
}

// --- whisper-server -----------------------------------------------------------------------------

export interface WhisperServerOptions {
  /**
   * e.g. `http://127.0.0.1:8178`, or with whisper-server's `--request-path` prefix
   * (`http://127.0.0.1:8178/psyche-<token>`); must be loopback (the server has no auth).
   */
  baseUrl: string;
  inferencePath?: string;
  fetch?: typeof fetch;
}

interface VerboseJson {
  segments?: { text?: string; start?: number; end?: number }[];
  text?: string;
}

export class WhisperServerBackend implements WhisperBackend {
  readonly name = "whisper-server";
  readonly #opts: WhisperServerOptions;
  readonly #fetch: typeof fetch;

  constructor(options: WhisperServerOptions) {
    const host = new URL(options.baseUrl).hostname;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
      throw new PsycheError("invalid_params", "whisper-server must listen on loopback");
    }
    this.#opts = options;
    this.#fetch = options.fetch ?? fetch;
  }

  #url(path: string): string {
    return `${this.#opts.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  async available(): Promise<boolean> {
    try {
      const res = await this.#fetch(this.#url("/health"));
      return res.ok;
    } catch {
      return false;
    }
  }

  async transcribe(request: WhisperRequest): Promise<WhisperSegment[]> {
    const form = new FormData();
    const wav = encodeWav(request.pcm, PCM_16K_MONO);
    form.set("file", new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "in.wav");
    form.set("response_format", "verbose_json");
    form.set("language", request.language ?? "en");
    if (request.prompt !== undefined) form.set("prompt", request.prompt);
    if (request.vad === true) form.set("vad", "true");
    if (request.audioCtx !== undefined) form.set("audio_ctx", String(request.audioCtx));
    if (request.noFallback === true) form.set("temperature_inc", "0");
    const init: RequestInit = { method: "POST", body: form };
    if (request.signal !== undefined) init.signal = request.signal;
    const url = this.#url(this.#opts.inferencePath ?? "/inference");
    const res = await this.#fetch(url, init);
    if (!res.ok) throw new PsycheError("internal", `whisper-server answered HTTP ${res.status}`);
    const doc = (await res.json()) as VerboseJson;
    const segs = doc.segments ?? [{ text: doc.text ?? "", start: 0, end: 0 }];
    return segs
      .map((s) => ({
        text: cleanWhisperText(s.text ?? ""),
        startMs: Math.round((s.start ?? 0) * 1000),
        endMs: Math.round((s.end ?? 0) * 1000),
      }))
      .filter((s) => s.text !== "");
  }
}

// --- engine -------------------------------------------------------------------------------------

export interface WhisperStreamOptions {
  /** VAD frame length. */
  frameMs: number;
  /** RMS level above which a frame counts as speech (raised by an adaptive noise floor). */
  speechThreshold: number;
  /** Silence that ends an utterance. */
  endSilenceMs: number;
  /** Utterances are cut (and finalized) at this length. */
  maxUtteranceMs: number;
  /** Utterance audio between partial re-transcriptions; 0 disables partials. */
  partialIntervalMs: number;
  /** Audio kept before the first speech frame so word onsets are not clipped. */
  preRollMs: number;
  /**
   * Live dictation: size the encoder to the utterance (`audioCtxFor`) and skip the temperature
   * fallback, for partials and finals. On a CPU this is 3–4× faster per request with the same
   * words on the fixture (base.en: 160–210 ms instead of 0.5–0.9 s). Files run the full window.
   */
  fitAudioCtx: boolean;
}

export const DEFAULT_WHISPER_STREAM: WhisperStreamOptions = {
  frameMs: 30,
  speechThreshold: 0.015,
  endSilenceMs: 600,
  maxUtteranceMs: 15_000,
  partialIntervalMs: 1_000,
  preRollMs: 210,
  fitAudioCtx: true,
};

export interface WhisperEngineOptions {
  backend: WhisperBackend;
  /** `true` for `.en` models: language is forced to English. */
  englishOnly?: boolean;
  stream?: Partial<WhisperStreamOptions>;
  /** Decoder for non-PCM input (OGG, MP3, CAF…) to 16 kHz mono PCM; see `transcode/`. */
  decode?: (data: Uint8Array, format: AudioFormat, signal?: AbortSignal) => Promise<Uint8Array>;
}

export class WhisperEngine implements SpeechEngine, PathTranscriber {
  readonly #opts: WhisperEngineOptions;
  readonly #stream: WhisperStreamOptions;

  constructor(options: WhisperEngineOptions) {
    this.#opts = options;
    this.#stream = { ...DEFAULT_WHISPER_STREAM, ...options.stream };
  }

  available(): Promise<boolean> {
    return this.#opts.backend.available();
  }

  async capabilities(): Promise<SpeechCapabilities> {
    return {
      engine: `whisper.cpp (${this.#opts.backend.name})`,
      streaming: true,
      languages: this.#opts.englishOnly === true ? ["en"] : ["auto"],
    };
  }

  #language(options: TranscribeOptions): string {
    if (this.#opts.englishOnly === true) return "en";
    return options.language?.split(/[-_]/)[0] ?? "auto";
  }

  async #toPcm(data: Uint8Array, format: AudioFormat, signal?: AbortSignal): Promise<Uint8Array> {
    if (isPcm(format)) return toPcm16kMono(data, format);
    if (format.encoding === "wav") {
      const wav = decodeWav(data);
      if (wav !== undefined) return toPcm16kMono(wav.data, wav.format);
    }
    if (this.#opts.decode === undefined) {
      throw new PsycheError("invalid_params", `whisper engine cannot decode ${format.encoding}`);
    }
    return this.#opts.decode(data, format, signal);
  }

  async transcribeFile(
    data: Uint8Array,
    format: AudioFormat,
    options: TranscribeOptions = {},
  ): Promise<Transcript> {
    const pcm = await this.#toPcm(data, format, options.signal);
    const language = this.#language(options);
    // Whisper (tiny/base especially) tends to stop decoding after a long pause, dropping
    // everything that follows; one call per utterance avoids that and yields real timestamps.
    const seq = new SegmentSequencer();
    const utterances = this.#segments(once(pcm), PCM_16K_MONO, options, {
      partialIntervalMs: 0,
      fitAudioCtx: false,
      maxUtteranceMs: FILE_MAX_UTTERANCE_MS,
    });
    for await (const s of utterances) seq.push(s);
    return seq.transcript(language === "auto" ? undefined : language);
  }

  /**
   * A long PCM WAV recording on disk (a meeting), read in chunks so it is never all in memory,
   * cut at pauses like `transcribeFile`. Other containers are refused (`unsupported`): the caller
   * falls back to an engine that decodes them.
   */
  async transcribePath(path: string, options: PathTranscribeOptions = {}): Promise<PathTranscript> {
    const info = await pcmWavInfo(path);
    if (info === undefined) {
      throw new PsycheError("invalid_params", "whisper reads PCM WAV recordings only", {
        details: { reason: "not_wav" },
      });
    }
    const wav = info;
    const bytesPerMs =
      (wav.format.sampleRate * bytesPerSample(wav.format) * wav.format.channels) / 1000;
    const totalMs = Math.round(wav.dataBytes / bytesPerMs);
    const maxMs = options.maxDurationMs ?? 4 * 60 * 60_000;
    if (totalMs > maxMs) {
      throw new PsycheError("invalid_params", `the recording is longer than ${maxMs} ms`);
    }
    const language = this.#language(options);
    const seq = new SegmentSequencer();
    const fh = await open(path, "r");
    let read = 0;
    const chunk = Math.max(4096, Math.round(bytesPerMs * 5_000));
    async function* pcm(): AsyncIterable<Uint8Array> {
      while (read < wav.dataBytes) {
        const buf = new Uint8Array(Math.min(chunk, wav.dataBytes - read));
        const { bytesRead } = await fh.read(buf, 0, buf.byteLength, wav.dataOffset + read);
        if (bytesRead === 0) return;
        read += bytesRead;
        yield buf.subarray(0, bytesRead);
      }
    }
    try {
      const utterances = this.#segments(pcm(), wav.format, options, {
        partialIntervalMs: 0,
        fitAudioCtx: false,
        maxUtteranceMs: FILE_MAX_UTTERANCE_MS,
      });
      for await (const s of utterances) {
        seq.push(s);
        const processedMs = Math.min(totalMs, Math.round(read / bytesPerMs));
        options.onProgress?.({
          type: "speech.progress",
          processedMs,
          totalMs,
          fraction: totalMs === 0 ? 1 : processedMs / totalMs,
          chunk: 0,
          chunks: 1,
        });
      }
    } finally {
      await fh.close();
    }
    const t = seq.transcript(language === "auto" ? undefined : language);
    return {
      ...t,
      audioMs: totalMs,
      engine: `whisper.cpp (${this.#opts.backend.name})`,
      chunks: 1,
    };
  }

  transcribeStream(
    audio: AsyncIterable<Uint8Array>,
    format: AudioFormat,
    options: TranscribeOptions = {},
  ): AsyncIterable<TranscriptSegment> {
    if (!isPcm(format)) {
      throw new PsycheError("invalid_params", "streaming dictation takes raw PCM");
    }
    // Load the model while the owner starts speaking; the first partial needs it within ~1 s.
    void this.#opts.backend.warm?.().catch(() => undefined);
    return sequenceSegments(this.#segments(audio, format, options), options.signal);
  }

  async *#segments(
    audio: AsyncIterable<Uint8Array>,
    format: AudioFormat,
    options: TranscribeOptions,
    overrides: Partial<WhisperStreamOptions> = {},
  ): AsyncIterable<TranscriptSegment> {
    const cfg = { ...this.#stream, ...overrides };
    const frameBytes = (16_000 * cfg.frameMs * 2) / 1000;
    const language = this.#language(options);
    assertPcmFormat(format);
    const inFrame = bytesPerSample(format) * format.channels;
    const resampler = new StreamingResampler(format.sampleRate, 16_000);

    let carry: Uint8Array = new Uint8Array(0); // input bytes short of a whole frame
    let pending: Uint8Array = new Uint8Array(0); // 16 kHz PCM not yet through the VAD
    let utter: Uint8Array[] = []; // current utterance (16 kHz frames)
    let preRoll: Uint8Array[] = [];
    let utterStartMs = 0;
    let silenceMs = 0;
    let sincePartial = 0;
    let clockMs = 0;
    let noiseFloor = 0;
    let lastFinal = "";

    const infer = async (frames: Uint8Array[], fit = cfg.fitAudioCtx): Promise<string> => {
      const prompt = whisperPrompt(options.vocabulary, undefined, lastFinal.slice(-200));
      const req: WhisperRequest = { pcm: concatBytes(frames), language };
      if (fit) {
        req.audioCtx = audioCtxFor(req.pcm.byteLength);
        req.noFallback = true;
      }
      if (prompt !== undefined) req.prompt = prompt;
      if (options.signal !== undefined) req.signal = options.signal;
      const segs = await this.#opts.backend.transcribe(req);
      return joinSegments(segs.map((s) => ({ ...s, final: true })));
    };

    const finalize = async (): Promise<TranscriptSegment | undefined> => {
      if (utter.length === 0) return undefined;
      const frames = utter;
      const startMs = utterStartMs;
      const endMs = utterStartMs + frames.length * cfg.frameMs;
      utter = [];
      silenceMs = 0;
      sincePartial = 0;
      let text = await infer(frames);
      // The fitted encoder occasionally decodes speech as punctuation ("-", "..."): the final
      // is what gets inserted, so that utterance runs again on the full window with fallback.
      if (cfg.fitAudioCtx && text !== "" && !/[\p{L}\p{N}]/u.test(text)) {
        text = await infer(frames, false);
      }
      if (text === "") return undefined;
      lastFinal = text;
      return { text, startMs, endMs, final: true };
    };

    for await (const chunk of audio) {
      if (options.signal?.aborted === true) return;
      const input = concatBytes([carry, chunk]);
      const whole = input.byteLength - (input.byteLength % inFrame);
      carry = input.slice(whole);
      const mono = pcmToFloat32(input.subarray(0, whole), format);
      pending = concatBytes([pending, float32ToS16le(resampler.push(mono))]);
      while (pending.byteLength >= frameBytes) {
        const frame = pending.slice(0, frameBytes);
        pending = pending.slice(frameBytes);
        const level = rms(pcmToFloat32(frame, PCM_16K_MONO));
        const speech = level > Math.max(cfg.speechThreshold, noiseFloor * 3);
        if (!speech) noiseFloor = noiseFloor === 0 ? level : noiseFloor * 0.95 + level * 0.05;
        clockMs += cfg.frameMs;
        if (utter.length === 0) {
          if (!speech) {
            preRoll.push(frame);
            if (preRoll.length * cfg.frameMs > cfg.preRollMs) preRoll.shift();
            continue;
          }
          utter = [...preRoll, frame];
          utterStartMs = clockMs - utter.length * cfg.frameMs;
          preRoll = [];
        } else {
          utter.push(frame);
          silenceMs = speech ? 0 : silenceMs + cfg.frameMs;
        }
        const utterMs = utter.length * cfg.frameMs;
        if (silenceMs >= cfg.endSilenceMs || utterMs >= cfg.maxUtteranceMs) {
          const seg = await finalize();
          if (seg !== undefined) yield seg;
          continue;
        }
        sincePartial += cfg.frameMs;
        if (cfg.partialIntervalMs > 0 && sincePartial >= cfg.partialIntervalMs && silenceMs === 0) {
          sincePartial = 0;
          const text = await infer(utter);
          if (text !== "") {
            yield { text, startMs: utterStartMs, endMs: utterStartMs + utterMs, final: false };
          }
        }
      }
    }
    if (options.signal?.aborted === true) return;
    const seg = await finalize();
    if (seg !== undefined) yield seg;
  }
}

/** Files are cut into utterances of at most this length (whisper's window is 30 s). */
const FILE_MAX_UTTERANCE_MS = 25_000;

async function* once(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

/** Where a PCM WAV file's samples are (`decodeWav` over the first 64 KiB, which holds the header). */
export async function pcmWavInfo(
  path: string,
): Promise<{ format: AudioFormat; dataOffset: number; dataBytes: number } | undefined> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const head = new Uint8Array(Math.min(size, 65_536));
    await fh.read(head, 0, head.byteLength, 0);
    const wav = decodeWav(head);
    if (wav === undefined) return undefined;
    const dataOffset = wav.data.byteOffset - head.byteOffset;
    const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const declared = v.getUint32(dataOffset - 4, true);
    // A recorder that never finalized the header writes 0 or 0xFFFFFFFF: read to the end.
    const toEnd = size - dataOffset;
    const dataBytes =
      declared === 0 || declared === 0xffff_ffff ? toEnd : Math.min(declared, toEnd);
    return { format: wav.format, dataOffset, dataBytes };
  } finally {
    await fh.close();
  }
}

/** `.en` model detection from a model file name (`ggml-base.en.bin`). */
export function isEnglishOnlyModel(path: string): boolean {
  return /\.en([.\-_]|$)/.test(path.split("/").pop() ?? "");
}
