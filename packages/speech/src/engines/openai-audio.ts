import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { PsycheError } from "@psyche/protocol";
import type { PathTranscribeOptions, PathTranscriber, PathTranscript } from "./node.ts";

/**
 * A long recording transcribed by any OpenAI-compatible `/v1/audio/transcriptions` endpoint
 * (whisper.cpp's server, faster-whisper-server, a hosted Whisper API). It is the speech part's
 * `PathTranscriber` for platforms without the Mac helper (#842 item 5): meeting notes and Record
 * meeting work there. The Mac helper still wins when it is online, since it runs on the device.
 *
 * The audio goes to the endpoint the owner configured, so only `https:` and loopback `http:` are
 * accepted: a recording never goes to a plain-text address on the network.
 */

/** The endpoint's default timeout for one recording; a 4-hour meeting can take a while on CPU. */
const DEFAULT_TIMEOUT_MS = 60 * 60_000;
/** Whisper takes about 224 tokens of prompt; a generous character cap keeps it under that. */
const PROMPT_CHARS = 800;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface OpenAiAudioOptions {
  /** The endpoint's origin, e.g. `http://127.0.0.1:8080`; the path `/v1/audio/transcriptions` is added. */
  baseUrl: string;
  /** The model name the endpoint expects, e.g. `whisper-1`. */
  model: string;
  /** Bearer token for hosted endpoints; a local server needs none. */
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** The subset of OpenAI's `verbose_json` response this reads. */
interface VerboseJson {
  text?: unknown;
  language?: unknown;
  duration?: unknown;
  segments?: unknown;
}

/** Rejects an endpoint that would send a recording over an unencrypted network path. */
export function endpointUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL("/v1/audio/transcriptions", baseUrl);
  } catch (cause) {
    throw new PsycheError("invalid_params", "the transcription endpoint is not a URL", { cause });
  }
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new PsycheError(
      "invalid_params",
      "the transcription endpoint must be https, or http on this Mac (127.0.0.1)",
    );
  }
  return url;
}

export class OpenAiAudioTranscriber implements PathTranscriber {
  readonly #url: URL;
  readonly #o: OpenAiAudioOptions;

  constructor(options: OpenAiAudioOptions) {
    this.#url = endpointUrl(options.baseUrl);
    this.#o = options;
  }

  async transcribePath(path: string, options: PathTranscribeOptions = {}): Promise<PathTranscript> {
    const file = await openAsBlob(path);
    const form = new FormData();
    form.append("file", file, basename(path));
    form.append("model", this.#o.model);
    form.append("response_format", "verbose_json");
    if (options.language !== undefined) form.append("language", options.language);
    const prompt = (options.vocabulary ?? []).join(", ").slice(0, PROMPT_CHARS);
    if (prompt !== "") form.append("prompt", prompt);

    const timeout = AbortSignal.timeout(this.#o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal =
      options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
    const send = this.#o.fetch ?? fetch;
    const res = await send(this.#url, {
      method: "POST",
      headers: this.#o.apiKey === undefined ? {} : { authorization: `Bearer ${this.#o.apiKey}` },
      body: form,
      signal,
    }).catch((cause: unknown) => {
      throw new PsycheError("unavailable", "the transcription endpoint did not answer", {
        retryable: true,
        cause,
      });
    });
    if (!res.ok) {
      throw new PsycheError(
        "unavailable",
        `the transcription endpoint failed (HTTP ${res.status})`,
        {
          retryable: res.status >= 500,
        },
      );
    }
    const body = (await res.json()) as VerboseJson;
    return toTranscript(body, this.#o.model, options.maxDurationMs);
  }
}

/** Maps a `verbose_json` body to the speech part's long-form transcript (segment times in ms). */
export function toTranscript(
  body: VerboseJson,
  model: string,
  maxDurationMs?: number,
): PathTranscript {
  if (typeof body.text !== "string") {
    throw new PsycheError("unavailable", "the transcription endpoint sent no text", {
      retryable: true,
    });
  }
  const duration =
    typeof body.duration === "number" && Number.isFinite(body.duration) ? body.duration : 0;
  const audioMs = Math.max(0, Math.round(duration * 1000));
  if (maxDurationMs !== undefined && audioMs > maxDurationMs) {
    throw new PsycheError("invalid_params", "the recording is longer than the transcription limit");
  }
  const raw = Array.isArray(body.segments) ? body.segments : [];
  const segments = raw
    .filter((s): s is { start: number; end: number; text: string } => {
      const x = s as Partial<{ start: unknown; end: unknown; text: unknown }>;
      return typeof x.start === "number" && typeof x.end === "number" && typeof x.text === "string";
    })
    .map((s) => ({
      text: s.text.trim(),
      startMs: Math.round(s.start * 1000),
      endMs: Math.round(s.end * 1000),
      final: true,
    }));
  return {
    text: body.text.trim(),
    segments,
    ...(typeof body.language === "string" ? { language: body.language } : {}),
    audioMs,
    engine: `openai-audio:${model}`,
    chunks: 1,
  };
}
