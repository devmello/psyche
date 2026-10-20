import {
  type AudioFormat,
  type LibraryItem,
  type Provenance,
  PsycheError,
  type SpeechEngine,
} from "@psyche/protocol";
import { concatBytes } from "./audio.ts";
import { toBase64 } from "./queue.ts";
import type { VoiceNoteTranscoder } from "./transcode/ffmpeg.ts";
import { LIBRARY_AUDIO_PROFILE } from "./transcode/formats.ts";

/**
 * `speech.readAloud(messageId)` (feature Q3: "a message can be played and saved as a file").
 * Synthesizes the message with the selected voice, streams the PCM to the requesting device as
 * `speech.audio` events so playback starts with the first sentence, then encodes MP3 and stores
 * it as a Library `audio` item, announced by `speech.readAloud.completed`.
 *
 * The message text is read as plain text: Markdown is flattened and any markup is removed, so
 * a message (which may quote untrusted content) cannot steer synthesis with SSML.
 */

export interface MessageSource {
  /** Plain or Markdown text of a message the caller may read; rejects `not_found` otherwise. */
  get(messageId: string): Promise<{ text: string; threadId: string | null }>;
}

/** What the Gateway's Library needs to store a clip (read-aloud) or a recording (voice memo). */
export interface LibrarySaveInput {
  data: Uint8Array;
  name: string;
  mime: string;
  threadId: string | null;
  tags: string[];
  /** Default `audio` (synthesized); voice memos are `recording`. */
  kind?: "audio" | "recording";
  /** Default `agent`; a composer memo is `upload`, a channel voice note `channel`. */
  origin?: LibraryItem["origin"];
  /** Who produced the content; `untrusted` recordings follow the quarantine rules (data model §9). */
  provenance?: Provenance;
  /** Plain text of the audio (a transcript), stored as the item's text extract. */
  textExtract?: string;
}

export interface LibraryWriter {
  saveAudio(file: LibrarySaveInput): Promise<LibraryItem>;
}

export type ReadAloudEvent =
  | {
      event: "speech.audio";
      payload: { streamId: string; seq: number; audio: string; format: AudioFormat; last: boolean };
    }
  | {
      event: "speech.readAloud.completed";
      payload: { streamId: string; messageId: string; item: LibraryItem; durationMs: number };
    }
  | {
      event: "speech.readAloud.failed";
      payload: { streamId: string; messageId: string; error: { code: string; message: string } };
    };

export interface ReadAloudOptions {
  engine: SpeechEngine;
  transcoder: VoiceNoteTranscoder;
  messages: MessageSource;
  library: LibraryWriter;
  emit: (deviceId: string, event: ReadAloudEvent) => void;
  newId?: () => string;
  /** Longer messages are refused (a read-aloud is not an audiobook). */
  maxChars?: number;
  /**
   * The persona's voice (IDENTITY.md `voice:`, `<engine>:<voice>`), used when the request names
   * none (feature Q3: voice selection per persona). Falls back to `speech.tts.voice`.
   */
  personaVoice?: () => Promise<string | undefined> | string | undefined;
  /**
   * `true` when the voice that will read is an Apple Personal Voice (`VoiceCatalog.isNonCommercial`):
   * the Library item is tagged `non-commercial` because Apple's terms limit that output.
   */
  nonCommercial?: (voiceRef: string | undefined) => Promise<boolean> | boolean;
}

export const READ_ALOUD_MAX_CHARS = 20_000;

/** Flattens Markdown into speakable text. */
export function markdownToSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " (code omitted) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(\S[\s\S]*?\S|\S)\1/g, "$2")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/\|/g, ", ")
    .replace(/[<>]/g, " ")
    .replace(/\n{2,}/g, ".\n")
    .replace(/\s+/g, " ")
    .replace(/\.\s*\./g, ".")
    .trim();
}

export interface ReadAloudStartOptions {
  voice?: string;
  signal?: AbortSignal;
  /**
   * Default `true`. `false` streams `speech.audio` only: no MP3, no Library item and no
   * `speech.readAloud.completed` (voice mode, feature Q5); `done` resolves `null`.
   */
  save?: boolean;
}

export class ReadAloudService {
  readonly #opts: ReadAloudOptions;
  #counter = 0;
  /** Running streams, so `cancel` can stop one (only for the device that started it). */
  readonly #streams = new Map<string, { deviceId: string; abort: AbortController }>();

  async #nonCommercial(voice: string | undefined): Promise<boolean> {
    try {
      return (await this.#opts.nonCommercial?.(voice)) === true;
    } catch {
      // Unknown is not an excuse to drop the caveat: a failing check tags the clip.
      return this.#opts.nonCommercial !== undefined;
    }
  }

  constructor(options: ReadAloudOptions) {
    this.#opts = options;
  }

  /**
   * Starts a read-aloud and returns its stream id at once; `done` settles when the Library item
   * exists (the Gateway answers the method with `streamId` and lets `done` run), or with `null`
   * once the audio is out when `save` is `false`.
   */
  start(
    messageId: string,
    deviceId: string,
    options: ReadAloudStartOptions = {},
  ): { streamId: string; done: Promise<LibraryItem | null> } {
    const streamId = this.#opts.newId?.() ?? `ra_${Date.now().toString(36)}_${++this.#counter}`;
    const abort = new AbortController();
    const outer = options.signal;
    const onOuter = () => abort.abort();
    if (outer?.aborted === true) abort.abort();
    else outer?.addEventListener("abort", onOuter, { once: true });
    this.#streams.set(streamId, { deviceId, abort });
    const run = this.#run(streamId, messageId, deviceId, { ...options, signal: abort.signal });
    const done = run
      .finally(() => {
        outer?.removeEventListener("abort", onOuter);
        this.#streams.delete(streamId);
      })
      .catch((err: unknown) => {
        const error =
          err instanceof PsycheError
            ? { code: err.code, message: err.message }
            : { code: "internal", message: "read-aloud failed" };
        this.#opts.emit(deviceId, {
          event: "speech.readAloud.failed",
          payload: { streamId, messageId, error },
        });
        throw err;
      });
    done.catch(() => {});
    return { streamId, done };
  }

  /**
   * Stops a running stream now (`speech.readAloud.cancel`, voice-mode barge-in). Another device's
   * stream id is treated like an unknown one; both answer without error.
   */
  cancel(streamId: string, deviceId: string): void {
    const s = this.#streams.get(streamId);
    if (s === undefined || s.deviceId !== deviceId) return;
    s.abort.abort();
  }

  /** Streams still running (tests, shutdown). */
  get active(): number {
    return this.#streams.size;
  }

  async #run(
    streamId: string,
    messageId: string,
    deviceId: string,
    options: ReadAloudStartOptions & { signal: AbortSignal },
  ): Promise<LibraryItem | null> {
    const msg = await this.#opts.messages.get(messageId);
    const text = markdownToSpeech(msg.text);
    if (text === "") throw new PsycheError("invalid_params", "the message has nothing to read");
    if (text.length > (this.#opts.maxChars ?? READ_ALOUD_MAX_CHARS)) {
      throw new PsycheError("invalid_params", "the message is too long to read aloud");
    }
    const voice = options.voice ?? (await this.#opts.personaVoice?.());
    const synth: { voice?: string; signal?: AbortSignal } = {};
    if (voice !== undefined && voice !== "") synth.voice = voice;
    if (options.signal !== undefined) synth.signal = options.signal;
    const parts: Uint8Array[] = [];
    let format: AudioFormat | undefined;
    let seq = 0;
    let pending: { data: Uint8Array; format: AudioFormat } | undefined;
    const send = (last: boolean) => {
      if (pending === undefined) return;
      this.#opts.emit(deviceId, {
        event: "speech.audio",
        payload: {
          streamId,
          seq: seq++,
          audio: toBase64(pending.data),
          format: pending.format,
          last,
        },
      });
      pending = undefined;
    };
    for await (const chunk of this.#opts.engine.synthesize(text, synth)) {
      // Cancelled (barge-in): send nothing more, not even the held-back chunk.
      if (options.signal.aborted) break;
      if (format !== undefined && !sameFormat(format, chunk.format)) {
        throw new PsycheError("internal", "engine changed audio format mid-stream");
      }
      format = chunk.format;
      parts.push(chunk.data);
      // One chunk of look-ahead so the final event can carry `last: true`.
      send(false);
      pending = chunk;
    }
    if (options.signal.aborted) throw new PsycheError("cancelled", "read-aloud cancelled");
    send(true);
    if (format === undefined) throw new PsycheError("internal", "the engine produced no audio");
    if (options.save === false) return null;
    const encoded = await this.#opts.transcoder.encode(
      concatBytes(parts),
      format,
      LIBRARY_AUDIO_PROFILE,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    const item = await this.#opts.library.saveAudio({
      data: encoded.data,
      name: `${titleFrom(text)}.${encoded.extension}`,
      mime: encoded.mime,
      threadId: msg.threadId,
      tags: [
        "read-aloud",
        `message:${messageId}`,
        ...((await this.#nonCommercial(synth.voice)) ? ["non-commercial"] : []),
      ],
    });
    this.#opts.emit(deviceId, {
      event: "speech.readAloud.completed",
      payload: { streamId, messageId, item, durationMs: encoded.durationMs },
    });
    return item;
  }
}

function sameFormat(a: AudioFormat, b: AudioFormat): boolean {
  return a.encoding === b.encoding && a.sampleRate === b.sampleRate && a.channels === b.channels;
}

/** A file-name-safe title from the first words of the text. */
export function titleFrom(text: string): string {
  const words = text
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join(" ");
  return `Read aloud – ${words === "" ? "message" : words}`.slice(0, 80);
}
