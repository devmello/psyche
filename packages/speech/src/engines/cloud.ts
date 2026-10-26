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
 * Transport: the input-streaming WebSocket (`/stream-input`, `auto_mode`) by default, which
 * answers with the first audio in about 100–150 ms (docs/voice/voice-mode-2026.md §5); the key
 * goes in the first message, never in the URL. `transport: "http"` keeps the `/stream` request.
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

/** The part of a WHATWG `WebSocket` the engine uses (Node 24's global, or a fake in tests). */
export interface TtsSocket {
  send(data: string): void;
  close(code?: number): void;
  addEventListener(type: "open" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (e: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (e: { code: number }) => void): void;
}

export interface CloudTtsOptions {
  provider: CloudProvider;
  apiKey: () => Promise<ResolvedSecret>;
  fetch?: typeof fetch;
  /** Default `"websocket"`. */
  transport?: "websocket" | "http";
  /** Opens the streaming socket; default Node's global `WebSocket`. */
  webSocket?: (url: string) => TtsSocket;
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
    if ((this.#opts.transport ?? "websocket") === "websocket") {
      yield* this.#streamSocket(plain, options);
      return;
    }
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

  /**
   * One input-streaming socket per call: the key in the first message, the text as sentences, an
   * empty text to flush, then base64 PCM frames until `isFinal`. Abort closes the socket at once.
   */
  async *#streamSocket(text: string, options: SynthesizeOptions): AsyncIterable<AudioChunk> {
    const voice = this.#voice(options);
    const base = new URL(this.#opts.baseUrl ?? "https://api.elevenlabs.io");
    base.protocol = base.protocol === "http:" ? "ws:" : "wss:";
    const url = new URL(`/v1/text-to-speech/${encodeURIComponent(voice)}/stream-input`, base);
    url.searchParams.set("model_id", this.#opts.model ?? "eleven_flash_v2_5");
    url.searchParams.set("output_format", "pcm_24000");
    url.searchParams.set("auto_mode", "true");

    const secret = await this.#opts.apiKey();
    const open = this.#opts.webSocket ?? ((u: string) => new WebSocket(u) as unknown as TtsSocket);
    const ws = open(url.href);
    const frames: Uint8Array[] = [];
    let opened = false;
    let finished = false;
    let failure: PsycheError | undefined;
    let wake: (() => void) | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    ws.addEventListener("open", () => {
      opened = true;
      notify();
    });
    ws.addEventListener("message", (e) => {
      const msg = parseSocketMessage(e.data);
      if (msg === undefined) return;
      if (typeof msg.audio === "string" && msg.audio !== "") {
        frames.push(new Uint8Array(Buffer.from(msg.audio, "base64")));
      }
      if (msg.isFinal === true) finished = true;
      // Error bodies are provider text; keep only a code so nothing echoed leaks into logs.
      if (typeof msg.error === "string" || typeof msg.message === "string") {
        failure ??= socketError(String(msg.error ?? ""), undefined);
      }
      notify();
    });
    ws.addEventListener("error", () => {
      failure ??= socketError("", undefined);
      notify();
    });
    ws.addEventListener("close", (e) => {
      if (!finished && failure === undefined && e.code !== 1000) {
        failure = socketError("", e.code);
      }
      finished = true;
      notify();
    });
    const abort = () => {
      finished = true;
      notify();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const wait = () => new Promise<void>((r) => (wake = r));
    const aborted = () => options.signal?.aborted === true;
    let odd: number | undefined;
    try {
      while (!opened && !finished && failure === undefined) await wait();
      if (failure !== undefined) throw failure;
      if (aborted() || finished) return;
      try {
        secret.use((key) => ws.send(JSON.stringify({ text: " ", xi_api_key: key })));
      } finally {
        secret.dispose();
      }
      for (const piece of packSentences(text, ELEVENLABS_MAX_INPUT)) {
        ws.send(JSON.stringify({ text: `${piece} ` }));
      }
      ws.send(JSON.stringify({ text: "" }));
      for (;;) {
        if (aborted()) return;
        const frame = frames.shift();
        if (frame !== undefined) {
          const aligned = align(frame, odd);
          odd = aligned.odd;
          if (aligned.bytes.byteLength > 0) yield { data: aligned.bytes, format: PCM_24K_MONO };
          continue;
        }
        if (failure !== undefined) throw failure;
        if (finished) return;
        await wait();
      }
    } finally {
      secret.dispose();
      options.signal?.removeEventListener("abort", abort);
      // An early return or a consumer that stopped must not leave the socket open.
      ws.close(1000);
    }
  }

  #voice(options: SynthesizeOptions): string {
    const voice = options.voice ?? this.#opts.defaultVoice;
    if (voice === undefined) {
      throw new PsycheError("invalid_params", "ElevenLabs needs a voice id");
    }
    return voice;
  }

  #speak(text: string, options: SynthesizeOptions): Promise<Response> {
    const voice = this.#voice(options);
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

/** Keeps chunks sample-aligned (2 bytes) across frames: `odd` carries a dangling byte. */
function align(value: Uint8Array, odd: number | undefined): { bytes: Uint8Array; odd?: number } {
  let bytes = value;
  if (odd !== undefined) {
    bytes = new Uint8Array(value.byteLength + 1);
    bytes[0] = odd;
    bytes.set(value, 1);
  }
  if (bytes.byteLength % 2 === 1) {
    return {
      bytes: bytes.subarray(0, bytes.byteLength - 1),
      odd: bytes[bytes.byteLength - 1] as number,
    };
  }
  return { bytes };
}

function parseSocketMessage(
  data: unknown,
): { audio?: unknown; isFinal?: unknown; error?: unknown; message?: unknown } | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const doc = JSON.parse(data) as unknown;
    return typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Maps an ElevenLabs socket error kind or close code to a Psyche error. The message never carries
 * provider text, which can echo the request.
 */
function socketError(kind: string, closeCode: number | undefined): PsycheError {
  const code =
    /auth|api_key|unauthori[sz]ed/i.test(kind) || closeCode === 1008
      ? "unauthorized"
      : /quota|rate|limit/i.test(kind)
        ? "rate_limited"
        : "unavailable";
  const detail = closeCode === undefined ? code : `close ${closeCode}`;
  return new PsycheError(code, `elevenlabs TTS stream failed (${detail})`, {
    retryable: code !== "unauthorized",
  });
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
