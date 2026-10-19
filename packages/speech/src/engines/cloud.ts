import {
  type AudioChunk,
  PsycheError,
  type ResolvedSecret,
  type SpeechCapabilities,
  type SpeechEngine,
  type SynthesizeOptions,
  type Transcript,
  type TranscriptSegment,
  type Voice,
} from "@psyche/protocol";
import { PCM_24K_MONO } from "../audio.ts";
import { splitSentences, ssmlToText } from "../ssml.ts";

/**
 * Cloud voices (feature Q3): OpenAI `/v1/audio/speech` and ElevenLabs text-to-speech. Both are
 * opt-in: they are not in the default synthesis order, they send the text off the machine, and
 * their API keys live in the vault. The engine never sees a key value outside the request it
 * builds: `apiKey()` returns a one-shot `ResolvedSecret` (the Gateway resolves
 * `{{cred:openai}}` / `{{cred:elevenlabs}}` after the Permission Broker approved the
 * `credential_fill`), and the key goes straight into one request header.
 *
 * Both providers are asked for raw 24 kHz mono s16le PCM (OpenAI `response_format: "pcm"`,
 * ElevenLabs `output_format=pcm_24000`), so the voice-note transcoder handles every channel.
 */

export type CloudProvider = "openai" | "elevenlabs";

export interface CloudTtsOptions {
  provider: CloudProvider;
  apiKey: () => Promise<ResolvedSecret>;
  fetch?: typeof fetch;
  /** OpenAI: `gpt-4o-mini-tts` (default), `tts-1`, `tts-1-hd`. ElevenLabs: `eleven_flash_v2_5`. */
  model?: string;
  defaultVoice?: string;
  /** OpenAI `instructions` (tone), not supported by tts-1 models. */
  instructions?: string;
  baseUrl?: string;
}

export const OPENAI_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;

/** OpenAI caps `input` at 4096 characters per request. */
const OPENAI_MAX_INPUT = 4_000;
const ELEVENLABS_MAX_INPUT = 4_000;

export class CloudTtsEngine implements SpeechEngine {
  readonly #opts: CloudTtsOptions;
  readonly #fetch: typeof fetch;

  constructor(options: CloudTtsOptions) {
    this.#opts = options;
    this.#fetch = options.fetch ?? fetch;
  }

  get provider(): CloudProvider {
    return this.#opts.provider;
  }

  async capabilities(): Promise<SpeechCapabilities> {
    return {
      engine: this.#opts.provider,
      streaming: false,
      synthesis: true,
      languages: ["*"],
    };
  }

  async voices(): Promise<Voice[]> {
    if (this.#opts.provider === "openai") {
      return OPENAI_VOICES.map((id) => ({ id, name: id, language: "*", local: false }));
    }
    // ElevenLabs voices are per account; listing them needs the key.
    const res = await this.#request("/v1/voices", { method: "GET" });
    const doc = (await res.json()) as { voices?: { voice_id: string; name: string }[] };
    return (doc.voices ?? []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      language: "*",
      local: false,
    }));
  }

  async *synthesize(text: string, options: SynthesizeOptions = {}): AsyncIterable<AudioChunk> {
    const format = options.format ?? PCM_24K_MONO;
    if (format.encoding !== "pcm_s16le" || format.sampleRate !== 24_000 || format.channels !== 1) {
      throw new PsycheError("invalid_params", "cloud voices return 24 kHz mono s16le PCM");
    }
    const plain = ssmlToText(text);
    const max = this.#opts.provider === "openai" ? OPENAI_MAX_INPUT : ELEVENLABS_MAX_INPUT;
    for (const piece of packSentences(plain, max)) {
      const res = await this.#speak(piece, options);
      if (res.body === null) continue;
      let odd: number | undefined;
      const reader = res.body.getReader();
      for (;;) {
        if (options.signal?.aborted === true) {
          await reader.cancel();
          return;
        }
        const { value, done } = await reader.read();
        if (done) break;
        // Keep chunks sample-aligned (2 bytes) across network reads.
        let bytes: Uint8Array = value;
        if (odd !== undefined) {
          bytes = new Uint8Array(value.byteLength + 1);
          bytes[0] = odd;
          bytes.set(value, 1);
          odd = undefined;
        }
        if (bytes.byteLength % 2 === 1) {
          odd = bytes[bytes.byteLength - 1];
          bytes = bytes.subarray(0, bytes.byteLength - 1);
        }
        if (bytes.byteLength > 0) yield { data: bytes, format: PCM_24K_MONO };
      }
    }
  }

  #speak(text: string, options: SynthesizeOptions): Promise<Response> {
    const voice = options.voice ?? this.#opts.defaultVoice;
    if (this.#opts.provider === "openai") {
      const body: Record<string, unknown> = {
        model: this.#opts.model ?? "gpt-4o-mini-tts",
        input: text,
        voice: voice ?? "alloy",
        response_format: "pcm",
      };
      if (this.#opts.instructions !== undefined) body.instructions = this.#opts.instructions;
      return this.#request("/v1/audio/speech", this.#json(body), options.signal);
    }
    if (voice === undefined) {
      throw new PsycheError("invalid_params", "ElevenLabs needs a voice id");
    }
    const path = `/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=pcm_24000`;
    const body = { text, model_id: this.#opts.model ?? "eleven_flash_v2_5" };
    return this.#request(path, this.#json(body), options.signal);
  }

  #json(body: unknown): RequestInit {
    return {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    };
  }

  async #request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const base =
      this.#opts.baseUrl ??
      (this.#opts.provider === "openai" ? "https://api.openai.com" : "https://api.elevenlabs.io");
    const secret = await this.#opts.apiKey();
    let res: Response;
    try {
      const headers = new Headers(init.headers);
      secret.use((key) => {
        if (this.#opts.provider === "openai") headers.set("authorization", `Bearer ${key}`);
        else headers.set("xi-api-key", key);
      });
      const req: RequestInit = { ...init, headers };
      if (signal !== undefined) req.signal = signal;
      res = await this.#fetch(new URL(path, base), req);
    } finally {
      secret.dispose();
    }
    if (!res.ok) {
      // Error bodies are provider text; keep only the status so nothing echoed leaks into logs.
      await res.body?.cancel();
      const code =
        res.status === 401 || res.status === 403
          ? "unauthorized"
          : res.status === 429
            ? "rate_limited"
            : "unavailable";
      throw new PsycheError(code, `${this.#opts.provider} TTS answered HTTP ${res.status}`, {
        retryable: res.status === 429 || res.status >= 500,
      });
    }
    return res;
  }

  // biome-ignore lint/correctness/useYield: cloud TTS engines do not transcribe
  async *transcribeStream(): AsyncIterable<TranscriptSegment> {
    throw new PsycheError("not_implemented", "cloud TTS engines do not transcribe");
  }

  async transcribeFile(): Promise<Transcript> {
    throw new PsycheError("not_implemented", "cloud TTS engines do not transcribe");
  }
}

/** Packs sentences into requests of at most `max` characters. */
export function packSentences(text: string, max: number): string[] {
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
