import {
  type AudioChunk,
  type AudioFormat,
  PsycheError,
  type SpeechCapabilities,
  type SpeechEngine,
  type SynthesizeOptions,
  type TranscribeOptions,
  type Transcript,
  type TranscriptSegment,
  type Voice,
} from "@psyche/protocol";

/**
 * Engine selection (feature Q1, ADR-014, architecture §5): the Mac node's engine when a Mac is
 * paired and online (SpeechAnalyzer on macOS 26+, Parakeet / WhisperKit on 14–15), then
 * whisper.cpp on the Gateway host, then Web Speech in the web client as the last resort.
 * Synthesis prefers local Kokoro, then the Mac node's AVSpeechSynthesizer; cloud voices are
 * used only when the owner adds them to the order (they need a vault key and send text out).
 * Both orders are owner settings (`speech.stt.order`, `speech.tts.order`).
 */

/** Where an engine runs. `client` engines run in the caller's browser, not on the Gateway. */
export type EngineLocation = "node" | "gateway" | "client" | "cloud";

export type SpeechPurpose = "dictation" | "file" | "synthesize";

/** Who asks: Web Speech is only usable when the audio never leaves a browser client. */
export type SpeechCaller = "desktop" | "web" | "channel" | "agent";

export interface SpeechSettings {
  stt: { order: string[]; language?: string; vocabulary?: string[] };
  tts: { order: string[]; voice?: string };
}

export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = {
  stt: { order: ["mac-node", "whisper", "web-speech"] },
  tts: { order: ["kokoro", "mac-node"], voice: "kokoro:af_heart" },
};

export interface EngineEntry {
  id: string;
  location: EngineLocation;
  supports: { transcribe: boolean; stream: boolean; synthesize: boolean };
  /** Absent for `client` engines: the Gateway only tells the client to use its own. */
  engine?: SpeechEngine;
  /** Cheap readiness probe (binary and model present, node online, key configured). */
  available(): Promise<boolean>;
}

export interface SelectionContext {
  purpose: SpeechPurpose;
  caller?: SpeechCaller;
  /** Voice reference `<engineId>:<voiceId>` (e.g. `kokoro:af_heart` from IDENTITY.md). */
  voice?: string;
}

export interface Selection {
  id: string;
  location: EngineLocation;
  engine?: SpeechEngine;
  /** Voice id inside the chosen engine (the part after `engineId:`), when one applies. */
  voice?: string;
}

export interface EngineStatus {
  id: string;
  location: EngineLocation;
  eligible: boolean;
  reason?: "unknown" | "unsupported" | "client_only" | "unavailable";
}

/** Splits `kokoro:af_heart` into engine and voice; a bare id is a voice for any engine. */
export function parseVoiceRef(ref: string | undefined): { engine?: string; voice?: string } {
  if (ref === undefined || ref === "") return {};
  const i = ref.indexOf(":");
  if (i <= 0) return { voice: ref };
  return { engine: ref.slice(0, i), voice: ref.slice(i + 1) || undefined };
}

export class SpeechEngineSelector {
  readonly #entries = new Map<string, EngineEntry>();
  #settings: SpeechSettings;

  constructor(settings: SpeechSettings = DEFAULT_SPEECH_SETTINGS) {
    this.#settings = settings;
  }

  register(entry: EngineEntry): this {
    if (entry.location !== "client" && entry.engine === undefined) {
      throw new PsycheError("invalid_params", `engine ${entry.id} runs server-side but has none`);
    }
    this.#entries.set(entry.id, entry);
    return this;
  }

  unregister(id: string): void {
    this.#entries.delete(id);
  }

  get settings(): SpeechSettings {
    return this.#settings;
  }

  /** Applies `settings.changed`; takes effect on the next selection. */
  configure(settings: SpeechSettings): void {
    this.#settings = settings;
  }

  entry(id: string): EngineEntry | undefined {
    return this.#entries.get(id);
  }

  /** Every engine in the configured order with why it is or is not eligible (doctor, Settings). */
  async explain(ctx: SelectionContext): Promise<EngineStatus[]> {
    const out: EngineStatus[] = [];
    for (const id of this.#order(ctx)) out.push(await this.#status(id, ctx));
    return out;
  }

  /** First eligible engine in order; rejects `unavailable` when none is. */
  async select(ctx: SelectionContext): Promise<Selection> {
    const tried: EngineStatus[] = [];
    for (const id of this.#order(ctx)) {
      const status = await this.#status(id, ctx);
      tried.push(status);
      if (!status.eligible) continue;
      const entry = this.#entries.get(id) as EngineEntry;
      const sel: Selection = { id, location: entry.location };
      if (entry.engine !== undefined) sel.engine = entry.engine;
      const voice = this.#voiceFor(id, ctx);
      if (voice !== undefined) sel.voice = voice;
      return sel;
    }
    const why = tried.map((t) => `${t.id}: ${t.reason ?? "?"}`).join(", ");
    throw new PsycheError(
      "unavailable",
      `no ${ctx.purpose === "synthesize" ? "speech synthesis" : "transcription"} engine is available${why === "" ? "" : ` (${why})`}`,
      { details: { tried }, retryable: true },
    );
  }

  #order(ctx: SelectionContext): string[] {
    const base = ctx.purpose === "synthesize" ? this.#settings.tts.order : this.#settings.stt.order;
    if (ctx.purpose !== "synthesize") return [...base];
    // An explicit voice engine (persona voice) goes first; the rest of the order is the fallback.
    const pinned = parseVoiceRef(ctx.voice ?? this.#settings.tts.voice).engine;
    if (pinned === undefined || !this.#entries.has(pinned)) return [...base];
    return [pinned, ...base.filter((id) => id !== pinned)];
  }

  #voiceFor(id: string, ctx: SelectionContext): string | undefined {
    if (ctx.purpose !== "synthesize") return undefined;
    const ref = parseVoiceRef(ctx.voice ?? this.#settings.tts.voice);
    if (ref.voice === undefined) return undefined;
    return ref.engine === undefined || ref.engine === id ? ref.voice : undefined;
  }

  async #status(id: string, ctx: SelectionContext): Promise<EngineStatus> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return { id, location: "gateway", eligible: false, reason: "unknown" };
    const base = { id, location: entry.location };
    const supported =
      ctx.purpose === "synthesize"
        ? entry.supports.synthesize
        : ctx.purpose === "dictation"
          ? entry.supports.stream
          : entry.supports.transcribe;
    if (!supported) return { ...base, eligible: false, reason: "unsupported" };
    if (entry.location === "client" && ctx.caller !== "web") {
      return { ...base, eligible: false, reason: "client_only" };
    }
    let ok = false;
    try {
      ok = await entry.available();
    } catch {
      ok = false;
    }
    return ok ? { ...base, eligible: true } : { ...base, eligible: false, reason: "unavailable" };
  }
}

/**
 * One `SpeechEngine` that picks the engine per call, for consumers that just need "speech"
 * (channel adapters transcribing inbound voice notes, read-aloud). Client-only engines are never
 * chosen here because the caller is the Gateway itself.
 */
export class RoutedSpeechEngine implements SpeechEngine {
  readonly #selector: SpeechEngineSelector;
  readonly #caller: SpeechCaller;

  constructor(selector: SpeechEngineSelector, caller: SpeechCaller = "agent") {
    this.#selector = selector;
    this.#caller = caller;
  }

  async #pick(
    purpose: SpeechPurpose,
    voice?: string,
  ): Promise<Selection & { engine: SpeechEngine }> {
    const ctx: SelectionContext = { purpose, caller: this.#caller };
    if (voice !== undefined) ctx.voice = voice;
    const sel = await this.#selector.select(ctx);
    if (sel.engine === undefined) {
      throw new PsycheError("unavailable", `engine ${sel.id} runs in the client`);
    }
    return sel as Selection & { engine: SpeechEngine };
  }

  async capabilities(): Promise<SpeechCapabilities> {
    const stt = await this.#pick("file").catch(() => undefined);
    const tts = await this.#pick("synthesize").catch(() => undefined);
    const sttCaps = stt === undefined ? undefined : await stt.engine.capabilities();
    return {
      engine: `routed(${stt?.id ?? "-"}/${tts?.id ?? "-"})`,
      streaming: stt === undefined ? false : this.#selector.entry(stt.id)?.supports.stream === true,
      synthesis: tts !== undefined,
      languages: sttCaps?.languages ?? [],
    };
  }

  async *transcribeStream(
    audio: AsyncIterable<Uint8Array>,
    format: AudioFormat,
    options?: TranscribeOptions,
  ): AsyncIterable<TranscriptSegment> {
    const sel = await this.#pick("dictation");
    yield* sel.engine.transcribeStream(audio, format, withDefaults(options, this.#selector));
  }

  async transcribeFile(
    data: Uint8Array,
    format: AudioFormat,
    options?: TranscribeOptions,
  ): Promise<Transcript> {
    const sel = await this.#pick("file");
    return sel.engine.transcribeFile(data, format, withDefaults(options, this.#selector));
  }

  async *synthesize(text: string, options: SynthesizeOptions = {}): AsyncIterable<AudioChunk> {
    const sel = await this.#pick("synthesize", options.voice);
    const opts: SynthesizeOptions = { ...options };
    if (sel.voice !== undefined) opts.voice = sel.voice;
    else delete opts.voice;
    yield* sel.engine.synthesize(text, opts);
  }

  async voices(): Promise<Voice[]> {
    const out: Voice[] = [];
    for (const id of this.#selector.settings.tts.order) {
      const entry = this.#selector.entry(id);
      if (entry?.engine === undefined || !entry.supports.synthesize) continue;
      const ok = await entry.available().catch(() => false);
      if (!ok) continue;
      for (const v of await entry.engine.voices()) out.push({ ...v, id: `${id}:${v.id}` });
    }
    return out;
  }
}

function withDefaults(
  options: TranscribeOptions | undefined,
  selector: SpeechEngineSelector,
): TranscribeOptions {
  const out: TranscribeOptions = { ...options };
  const lang = selector.settings.stt.language;
  if (out.language === undefined && lang !== undefined) out.language = lang;
  const vocab = selector.settings.stt.vocabulary;
  if (vocab !== undefined && vocab.length > 0) {
    out.vocabulary = [...(out.vocabulary ?? []), ...vocab];
  }
  return out;
}
