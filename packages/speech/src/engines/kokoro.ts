import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AudioChunk,
  type AudioFormat,
  PsycheError,
  type SpeechCapabilities,
  type SpeechEngine,
  type SynthesizeOptions,
  type Transcript,
  type TranscriptSegment,
  type Voice,
} from "@psyche/protocol";
import { float32ToS16le, PCM_24K_MONO, resample } from "../audio.ts";
import { parseSsmlLite, splitSentences } from "../ssml.ts";

/**
 * Kokoro-82M (Apache-2.0, 24 kHz) local text-to-speech (feature Q3, ADR-014) on ONNX Runtime.
 *
 * Licensing shapes this module: `kokoro-js` (through `phonemizer`) and `sherpa-onnx` both embed
 * espeak-ng, which is GPL-3.0, and packages may not depend on GPL code. So this engine takes
 * two injected pieces instead of a bundled stack:
 *
 * - `ort`: the `onnxruntime-node` module (MIT, ~300 MB unpacked with every platform's binary),
 *   which the Gateway installs and passes in, so `@psyche/speech` stays light for every other
 *   consumer.
 * - `Phonemizer`: grapheme → IPA. `phonemize` (MIT, dictionary + rules) is the default the
 *   Gateway wires; IPA is mapped to Kokoro's misaki symbol set by `ipaToMisaki`.
 *
 * Model contract (onnx-community/Kokoro-82M-v1.0-ONNX): `input_ids` int64 [1, T] with 0 padding
 * at both ends (T ≤ 512), `style` float32 [1, 256] = row clamp(T-2, 0, 509) of the voice file
 * (510 × 256 float32), `speed` float32 [1]; output `waveform` float32 at 24 kHz.
 */

export const KOKORO_SAMPLE_RATE = 24_000;
export const KOKORO_MAX_TOKENS = 510;
const STYLE_DIM = 256;
const STYLE_ROWS = 510;

export type KokoroLanguage = "en-us" | "en-gb";

/** English voices shipped with Kokoro v1.0 (the set kokoro-js exposes). */
export const KOKORO_VOICES: readonly { id: string; name: string; language: KokoroLanguage }[] = [
  ...[
    "heart",
    "bella",
    "nicole",
    "alloy",
    "aoede",
    "jessica",
    "kore",
    "nova",
    "river",
    "sarah",
    "sky",
  ].map((n) => ({ id: `af_${n}`, name: cap(n), language: "en-us" as const })),
  ...["adam", "echo", "eric", "fenrir", "liam", "michael", "onyx", "puck", "santa"].map((n) => ({
    id: `am_${n}`,
    name: cap(n),
    language: "en-us" as const,
  })),
  ...["emma", "isabella", "alice", "lily"].map((n) => ({
    id: `bf_${n}`,
    name: cap(n),
    language: "en-gb" as const,
  })),
  ...["george", "lewis", "daniel", "fable"].map((n) => ({
    id: `bm_${n}`,
    name: cap(n),
    language: "en-gb" as const,
  })),
];

export const DEFAULT_KOKORO_VOICE = "af_heart";

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function kokoroLanguage(voice: string): KokoroLanguage {
  return voice.startsWith("b") ? "en-gb" : "en-us";
}

// --- G2P ----------------------------------------------------------------------------------------

export interface Phonemizer {
  readonly name: string;
  /** Text → IPA (stress marks allowed). */
  phonemize(text: string, language: KokoroLanguage): Promise<string>;
}

/**
 * Maps generic IPA onto misaki's symbols, which Kokoro v1.0 was trained on: diphthongs as single
 * capitals (eɪ→A, aɪ→I, aʊ→W, ɔɪ→Y, oʊ→O, əʊ→Q), affricates as ligatures (dʒ→ʤ, tʃ→ʧ), and a few
 * espeak/CMU-isms folded away (ɝ, ɫ, r, x, length marks in American English).
 */
export function ipaToMisaki(ipa: string, language: KokoroLanguage): string {
  let s = ipa.normalize("NFC");
  const pairs: [RegExp, string][] = [
    [/d͡?ʒ/g, "ʤ"],
    [/t͡?ʃ/g, "ʧ"],
    [/e͡?ɪ/g, "A"],
    [/a͡?ɪ/g, "I"],
    [/a͡?ʊ/g, "W"],
    [/ɔ͡?ɪ/g, "Y"],
    [/ɝ/g, "ɜɹ"],
    [/ɫ/g, "l"],
    [/r/g, "ɹ"],
    [/x/g, "k"],
    [/ɬ/g, "l"],
    [/ʲ/g, "j"],
    [/g/g, "ɡ"],
    [/‿|\u0361/g, ""],
  ];
  for (const [re, to] of pairs) s = s.replace(re, to);
  if (language === "en-us") {
    s = s.replace(/o͡?ʊ/g, "O").replace(/ː/g, "");
  } else {
    s = s.replace(/[əo]͡?ʊ/g, "Q");
  }
  return s.replace(/\s+/g, " ").trim();
}

/** Phoneme string → token ids; symbols outside the vocab are dropped. */
export function tokenizePhonemes(phonemes: string, vocab: ReadonlyMap<string, number>): number[] {
  const ids: number[] = [];
  for (const ch of phonemes) {
    const id = vocab.get(ch);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/** Splits token ids into ≤ `max` runs, preferring to cut after a space token. */
export function chunkTokens(
  ids: number[],
  spaceId: number | undefined,
  max = KOKORO_MAX_TOKENS,
): number[][] {
  const out: number[][] = [];
  let rest = ids;
  while (rest.length > max) {
    let cut = max;
    if (spaceId !== undefined) {
      const i = rest.lastIndexOf(spaceId, max - 1);
      if (i > max / 3) cut = i + 1;
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

// --- runtime ------------------------------------------------------------------------------------

/** The slice of `onnxruntime-node` this engine uses. */
export interface OrtModuleLike {
  InferenceSession: {
    create(path: string, options?: Record<string, unknown>): Promise<OrtSessionLike>;
  };
  Tensor: new (
    type: "int64" | "float32",
    data: BigInt64Array | Float32Array,
    dims: number[],
  ) => unknown;
}

export interface OrtSessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>>;
  release?(): Promise<void>;
}

/** What `KokoroEngine` needs from a runtime; `KokoroOnnxRuntime` is the real one. */
export interface KokoroRuntime {
  available(): Promise<boolean>;
  vocab(): Promise<ReadonlyMap<string, number>>;
  hasVoice(voice: string): Promise<boolean>;
  /** `ids` without padding (≤ 510). Returns 24 kHz float samples. */
  infer(ids: number[], voice: string, speed: number): Promise<Float32Array>;
}

export interface KokoroOnnxOptions {
  ort: OrtModuleLike | (() => Promise<OrtModuleLike>);
  /** `$PSYCHE_HOME/models/kokoro/model_quantized.onnx` (q8, 92 MB) by default. */
  modelPath: string;
  /** The model repo's `tokenizer.json` (phoneme vocab). */
  tokenizerPath: string;
  /** Directory of `<voice>.bin` style files. */
  voicesDir: string;
  /** ORT session options, e.g. `{intraOpNumThreads: 4}`. */
  sessionOptions?: Record<string, unknown>;
}

const VOICE_ID = /^[a-z]{2}_[a-z0-9]+$/;

export class KokoroOnnxRuntime implements KokoroRuntime {
  readonly #opts: KokoroOnnxOptions;
  #ort: OrtModuleLike | undefined;
  #session: Promise<OrtSessionLike> | undefined;
  #vocab: Promise<Map<string, number>> | undefined;
  readonly #styles = new Map<string, Promise<Float32Array>>();

  constructor(options: KokoroOnnxOptions) {
    this.#opts = options;
  }

  async available(): Promise<boolean> {
    const files = [this.#opts.modelPath, this.#opts.tokenizerPath];
    for (const f of files) {
      if (!(await exists(f))) return false;
    }
    try {
      await this.#module();
      return true;
    } catch {
      return false;
    }
  }

  async #module(): Promise<OrtModuleLike> {
    if (this.#ort === undefined) {
      const o = this.#opts.ort;
      this.#ort = typeof o === "function" ? await o() : o;
    }
    return this.#ort;
  }

  #sessionP(): Promise<OrtSessionLike> {
    this.#session ??= this.#module().then((ort) =>
      ort.InferenceSession.create(this.#opts.modelPath, this.#opts.sessionOptions ?? {}),
    );
    return this.#session;
  }

  vocab(): Promise<ReadonlyMap<string, number>> {
    this.#vocab ??= readFile(this.#opts.tokenizerPath, "utf8").then((text) => {
      const doc = JSON.parse(text) as { model?: { vocab?: Record<string, number> } };
      const v = doc.model?.vocab;
      if (v === undefined) throw new PsycheError("internal", "Kokoro tokenizer.json has no vocab");
      return new Map(Object.entries(v));
    });
    return this.#vocab;
  }

  #voicePath(voice: string): string {
    if (!VOICE_ID.test(voice))
      throw new PsycheError("invalid_params", `bad Kokoro voice id ${voice}`);
    return join(this.#opts.voicesDir, `${voice}.bin`);
  }

  hasVoice(voice: string): Promise<boolean> {
    return VOICE_ID.test(voice) ? exists(this.#voicePath(voice)) : Promise.resolve(false);
  }

  #style(voice: string): Promise<Float32Array> {
    let p = this.#styles.get(voice);
    if (p === undefined) {
      p = readFile(this.#voicePath(voice)).then((b) => {
        if (b.byteLength !== STYLE_ROWS * STYLE_DIM * 4) {
          throw new PsycheError("invalid_params", `Kokoro voice ${voice} has the wrong size`);
        }
        return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      });
      p.catch(() => this.#styles.delete(voice));
      this.#styles.set(voice, p);
    }
    return p;
  }

  async infer(ids: number[], voice: string, speed: number): Promise<Float32Array> {
    if (ids.length === 0) return new Float32Array(0);
    if (ids.length > KOKORO_MAX_TOKENS) {
      throw new PsycheError("invalid_params", `Kokoro takes at most ${KOKORO_MAX_TOKENS} tokens`);
    }
    const [ort, session, styles] = await Promise.all([
      this.#module(),
      this.#sessionP(),
      this.#style(voice),
    ]);
    const padded = BigInt64Array.from([0, ...ids, 0], (n) => BigInt(n));
    const row = Math.min(Math.max(ids.length, 0), STYLE_ROWS - 1);
    const style = styles.slice(row * STYLE_DIM, (row + 1) * STYLE_DIM);
    const out = await session.run({
      input_ids: new ort.Tensor("int64", padded, [1, padded.length]),
      style: new ort.Tensor("float32", style, [1, STYLE_DIM]),
      speed: new ort.Tensor("float32", Float32Array.from([speed]), [1]),
    });
    const wave = out.waveform?.data;
    if (!(wave instanceof Float32Array))
      throw new PsycheError("internal", "Kokoro returned no waveform");
    return wave;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// --- engine -------------------------------------------------------------------------------------

export interface KokoroEngineOptions {
  runtime: KokoroRuntime;
  phonemizer: Phonemizer;
  defaultVoice?: string;
}

export class KokoroEngine implements SpeechEngine {
  readonly #opts: KokoroEngineOptions;

  constructor(options: KokoroEngineOptions) {
    this.#opts = options;
  }

  async available(): Promise<boolean> {
    return (
      (await this.#opts.runtime.available()) &&
      (await this.#opts.runtime.hasVoice(this.#opts.defaultVoice ?? DEFAULT_KOKORO_VOICE))
    );
  }

  async capabilities(): Promise<SpeechCapabilities> {
    return { engine: "kokoro-82m", streaming: false, synthesis: true, languages: ["en"] };
  }

  async voices(): Promise<Voice[]> {
    const out: Voice[] = [];
    for (const v of KOKORO_VOICES) {
      if (await this.#opts.runtime.hasVoice(v.id)) {
        out.push({ id: v.id, name: v.name, language: v.language, local: true });
      }
    }
    return out;
  }

  /** Text (or SSML-lite) → phoneme token runs, one per sentence chunk. Exposed for tests. */
  async plan(
    text: string,
    voice: string,
  ): Promise<({ ids: number[]; speed: number } | { silenceMs: number })[]> {
    const vocab = await this.#opts.runtime.vocab();
    const lang = kokoroLanguage(voice);
    const steps: ({ ids: number[]; speed: number } | { silenceMs: number })[] = [];
    for (const part of parseSsmlLite(text)) {
      if (part.kind === "break") {
        steps.push({ silenceMs: part.ms });
        continue;
      }
      for (const sentence of splitSentences(part.text)) {
        const ipa = await this.#opts.phonemizer.phonemize(sentence, lang);
        const ids = tokenizePhonemes(ipaToMisaki(ipa, lang), vocab);
        for (const run of chunkTokens(ids, vocab.get(" ")))
          steps.push({ ids: run, speed: part.rate });
      }
    }
    return steps;
  }

  async *synthesize(text: string, options: SynthesizeOptions = {}): AsyncIterable<AudioChunk> {
    const voice = options.voice ?? this.#opts.defaultVoice ?? DEFAULT_KOKORO_VOICE;
    if (!(await this.#opts.runtime.hasVoice(voice))) {
      throw new PsycheError("not_found", `Kokoro voice ${voice} is not installed`);
    }
    const format = options.format ?? PCM_24K_MONO;
    if (format.encoding !== "pcm_s16le" && format.encoding !== "pcm_f32le") {
      throw new PsycheError("invalid_params", "Kokoro emits PCM; transcode for other formats");
    }
    for (const step of await this.plan(text, voice)) {
      if (isAborted(options.signal)) return;
      const samples =
        "silenceMs" in step
          ? new Float32Array(Math.round((step.silenceMs * KOKORO_SAMPLE_RATE) / 1000))
          : await this.#opts.runtime.infer(step.ids, voice, step.speed);
      if (isAborted(options.signal)) return;
      if (samples.length === 0) continue;
      yield { data: encode(samples, format), format };
    }
  }

  // biome-ignore lint/correctness/useYield: Kokoro does not transcribe
  async *transcribeStream(): AsyncIterable<TranscriptSegment> {
    throw new PsycheError("not_implemented", "Kokoro does not transcribe");
  }

  async transcribeFile(): Promise<Transcript> {
    throw new PsycheError("not_implemented", "Kokoro does not transcribe");
  }
}

/** Reads `aborted` through a call so TS does not keep an earlier narrowing. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function encode(samples: Float32Array, format: AudioFormat): Uint8Array {
  let mono = resample(samples, KOKORO_SAMPLE_RATE, format.sampleRate);
  if (format.channels > 1) {
    const multi = new Float32Array(mono.length * format.channels);
    for (let i = 0; i < mono.length; i++)
      multi.fill(mono[i] ?? 0, i * format.channels, (i + 1) * format.channels);
    mono = multi;
  }
  if (format.encoding === "pcm_f32le") return new Uint8Array(mono.buffer.slice(0));
  return float32ToS16le(mono);
}
