import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AudioChunk,
  type AudioFormat,
  PsycheError,
  type SpeechCapabilities,
  type SpeechEngine,
  type TranscribeOptions,
  type Transcript,
  type TranscriptSegment,
  type Voice,
} from "@psyche/protocol";
import {
  bytesPerSample,
  concatBytes,
  decodeWav,
  encodeWav,
  isPcm,
  PCM_16K_MONO,
  pcmToFloat32,
  rms,
  toPcm16kMono,
} from "../audio.ts";
import { assertOk, findBinary, LocalProcessRunner, type ProcessRunner } from "../process.ts";
import { joinSegments, SegmentSequencer, sequenceSegments } from "../stream.ts";
import { whisperPrompt } from "../vocabulary.ts";

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
  signal?: AbortSignal;
}

export interface WhisperBackend {
  readonly name: string;
  available(): Promise<boolean>;
  transcribe(request: WhisperRequest): Promise<WhisperSegment[]>;
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
  /** e.g. `http://127.0.0.1:8178`; must be loopback (the server has no auth). */
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

  async available(): Promise<boolean> {
    try {
      const res = await this.#fetch(new URL("/health", this.#opts.baseUrl));
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
    const init: RequestInit = { method: "POST", body: form };
    if (request.signal !== undefined) init.signal = request.signal;
    const url = new URL(this.#opts.inferencePath ?? "/inference", this.#opts.baseUrl);
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
}

export const DEFAULT_WHISPER_STREAM: WhisperStreamOptions = {
  frameMs: 30,
  speechThreshold: 0.015,
  endSilenceMs: 600,
  maxUtteranceMs: 15_000,
  partialIntervalMs: 1_000,
  preRollMs: 210,
};

export interface WhisperEngineOptions {
  backend: WhisperBackend;
  /** `true` for `.en` models: language is forced to English. */
  englishOnly?: boolean;
  stream?: Partial<WhisperStreamOptions>;
  /** Decoder for non-PCM input (OGG, MP3, CAF…) to 16 kHz mono PCM; see `transcode/`. */
  decode?: (data: Uint8Array, format: AudioFormat, signal?: AbortSignal) => Promise<Uint8Array>;
}

export class WhisperEngine implements SpeechEngine {
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
      synthesis: false,
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
      maxUtteranceMs: FILE_MAX_UTTERANCE_MS,
    });
    for await (const s of utterances) seq.push(s);
    return seq.transcript(language === "auto" ? undefined : language);
  }

  transcribeStream(
    audio: AsyncIterable<Uint8Array>,
    format: AudioFormat,
    options: TranscribeOptions = {},
  ): AsyncIterable<TranscriptSegment> {
    if (!isPcm(format)) {
      throw new PsycheError("invalid_params", "streaming dictation takes raw PCM");
    }
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
    const inFrame = bytesPerSample(format) * format.channels;

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

    const infer = async (frames: Uint8Array[]): Promise<string> => {
      const context = lastFinal === "" ? [] : [lastFinal.slice(-120)];
      const prompt = whisperPrompt([...(options.vocabulary ?? []), ...context]);
      const req: WhisperRequest = { pcm: concatBytes(frames), language };
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
      const text = await infer(frames);
      if (text === "") return undefined;
      lastFinal = text;
      return { text, startMs, endMs, final: true };
    };

    for await (const chunk of audio) {
      if (options.signal?.aborted === true) return;
      const input = concatBytes([carry, chunk]);
      const whole = input.byteLength - (input.byteLength % inFrame);
      carry = input.slice(whole);
      pending = concatBytes([pending, toPcm16kMono(input.subarray(0, whole), format)]);
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

  // biome-ignore lint/correctness/useYield: whisper.cpp does not synthesize
  async *synthesize(): AsyncIterable<AudioChunk> {
    throw new PsycheError("not_implemented", "whisper.cpp does not synthesize speech");
  }

  async voices(): Promise<Voice[]> {
    return [];
  }
}

/** Files are cut into utterances of at most this length (whisper's window is 30 s). */
const FILE_MAX_UTTERANCE_MS = 25_000;

async function* once(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

/** `.en` model detection from a model file name (`ggml-base.en.bin`). */
export function isEnglishOnlyModel(path: string): boolean {
  return /\.en([.\-_]|$)/.test(path.split("/").pop() ?? "");
}
