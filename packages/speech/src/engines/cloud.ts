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
 * Cloud voices (feature Q3): ElevenLabs text-to-speech. It is opt-in: not in the default synthesis
 * order, it sends the text off the machine, and its API key lives in the vault. The engine never
 * sees a key value outside the request it builds: `apiKey()` returns a one-shot `ResolvedSecret`
 * (the Gateway resolves `{{cred:elevenlabs}}` after the Permission Broker approved the
 * `credential_fill`), and the key goes straight into one request header.
 *
 * ElevenLabs is asked for raw 24 kHz mono s16le PCM (`output_format=pcm_24000`), so the
 * voice-note transcoder handles every channel.
 *
 * OpenAI's voice (`gpt-4o-mini-tts`) was removed: its TTS endpoints shut down on 2027-01-06
 * (docs/voice/research/cloud-voice-apis.md §2). A saved `openai:` voice ref is retired, see
 * `isRetiredVoiceRef`.
 */

export type CloudProvider = "elevenlabs";

/** Engines that used to exist; a voice ref naming one falls back to the default voice. */
export const RETIRED_VOICE_ENGINES = ["openai"] as const;

/** True for an `<engine>:<voice>` ref whose engine was removed (spec §2: OpenAI TTS shutdown). */
export function isRetiredVoiceRef(ref: unknown): boolean {
  if (typeof ref !== "string") return false;
  const colon = ref.indexOf(":");
  if (colon <= 0) return false;
  return (RETIRED_VOICE_ENGINES as readonly string[]).includes(ref.slice(0, colon));
}

export interface CloudTtsOptions {
  provider: CloudProvider;
  apiKey: () => Promise<ResolvedSecret>;
  fetch?: typeof fetch;
  /** Default `eleven_flash_v2_5`. */
  model?: string;
  defaultVoice?: string;
  baseUrl?: string;
}

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
    for (const piece of packSentences(plain, ELEVENLABS_MAX_INPUT)) {
      const res = await this.#speak(piece, options);
      if (res.body === null) continue;
      let odd: number | undefined;
      const reader = res.body.getReader();
      let complete = false;
      try {
        for (;;) {
          if (options.signal?.aborted === true) {
            await reader.cancel();
            return;
          }
          const { value, done } = await reader.read();
          if (done) {
            complete = true;
            break;
          }
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
      } finally {
        // An early return or a consumer that stopped must not leave the socket open.
        if (!complete) await reader.cancel().catch(() => {});
      }
    }
  }

  #speak(text: string, options: SynthesizeOptions): Promise<Response> {
    const voice = options.voice ?? this.#opts.defaultVoice;
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
    const base = this.#opts.baseUrl ?? "https://api.elevenlabs.io";
    const secret = await this.#opts.apiKey();
    let res: Response;
    try {
      const headers = new Headers(init.headers);
      secret.use((key) => headers.set("xi-api-key", key));
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
