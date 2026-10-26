import {
  type AudioFormat,
  PsycheError,
  type SpeechCapabilities,
  type SpeechEngine,
  type TranscribeOptions,
  type Transcript,
  type TranscriptSegment,
} from "@psyche/protocol";

/**
 * Engine selection (feature Q1, ADR-014, architecture §5): the Mac node's engine when a Mac is
 * paired and online (SpeechAnalyzer on macOS 26+, Parakeet / WhisperKit on 14–15), then
 * whisper.cpp on the Gateway host, then Web Speech in the web client as the last resort.
 * The order is an owner setting (`speech.stt.order`). Psyche does not speak, so there is no
 * synthesis order.
 */

/** Where an engine runs. `client` engines run in the caller's browser, not on the Gateway. */
export type EngineLocation = "node" | "gateway" | "client" | "cloud";

export type SpeechPurpose = "dictation" | "file";

/** Who asks: Web Speech is only usable when the audio never leaves a browser client. */
export type SpeechCaller = "desktop" | "web" | "channel" | "agent";

export interface SpeechSettings {
  stt: { order: string[]; language?: string; vocabulary?: string[] };
}

export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = {
  stt: { order: ["mac-node", "whisper", "web-speech"] },
};

export interface EngineEntry {
  id: string;
  location: EngineLocation;
  supports: { transcribe: boolean; stream: boolean };
  /** Absent for `client` engines: the Gateway only tells the client to use its own. */
  engine?: SpeechEngine;
  /** Cheap readiness probe (binary and model present, node online, key configured). */
  available(): Promise<boolean>;
}

export interface SelectionContext {
  purpose: SpeechPurpose;
  caller?: SpeechCaller;
}

export interface Selection {
  id: string;
  location: EngineLocation;
  engine?: SpeechEngine;
}

export interface EngineStatus {
  id: string;
  location: EngineLocation;
  eligible: boolean;
  reason?: "unknown" | "unsupported" | "client_only" | "unavailable";
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
      return sel;
    }
    const why = tried.map((t) => `${t.id}: ${t.reason ?? "?"}`).join(", ");
    throw new PsycheError(
      "unavailable",
      `no transcription engine is available${why === "" ? "" : ` (${why})`}`,
      { details: { tried }, retryable: true },
    );
  }

  #order(_ctx: SelectionContext): string[] {
    return [...this.#settings.stt.order];
  }

  async #status(id: string, ctx: SelectionContext): Promise<EngineStatus> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return { id, location: "gateway", eligible: false, reason: "unknown" };
    const base = { id, location: entry.location };
    const supported =
      ctx.purpose === "dictation" ? entry.supports.stream : entry.supports.transcribe;
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
 * (channel adapters transcribing inbound voice notes). Client-only engines are never
 * chosen here because the caller is the Gateway itself.
 */
export class RoutedSpeechEngine implements SpeechEngine {
  readonly #selector: SpeechEngineSelector;
  readonly #caller: SpeechCaller;

  constructor(selector: SpeechEngineSelector, caller: SpeechCaller = "agent") {
    this.#selector = selector;
    this.#caller = caller;
  }

  async #pick(purpose: SpeechPurpose): Promise<Selection & { engine: SpeechEngine }> {
    const ctx: SelectionContext = { purpose, caller: this.#caller };
    const sel = await this.#selector.select(ctx);
    if (sel.engine === undefined) {
      throw new PsycheError("unavailable", `engine ${sel.id} runs in the client`);
    }
    return sel as Selection & { engine: SpeechEngine };
  }

  async capabilities(): Promise<SpeechCapabilities> {
    const stt = await this.#pick("file").catch(() => undefined);
    const sttCaps = stt === undefined ? undefined : await stt.engine.capabilities();
    return {
      engine: `routed(${stt?.id ?? "-"})`,
      streaming: stt === undefined ? false : this.#selector.entry(stt.id)?.supports.stream === true,
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
