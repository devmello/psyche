import {
  type AudioFormat,
  type LibraryItem,
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

export interface LibraryWriter {
  saveAudio(file: {
    data: Uint8Array;
    name: string;
    mime: string;
    threadId: string | null;
    tags: string[];
  }): Promise<LibraryItem>;
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

export class ReadAloudService {
  readonly #opts: ReadAloudOptions;
  #counter = 0;

  constructor(options: ReadAloudOptions) {
    this.#opts = options;
  }

  /**
   * Starts a read-aloud and returns its stream id at once; `done` settles when the Library item
   * exists (the Gateway answers the method with `streamId` and lets `done` run).
   */
  start(
    messageId: string,
    deviceId: string,
    options: { voice?: string; signal?: AbortSignal } = {},
  ): { streamId: string; done: Promise<LibraryItem> } {
    const streamId = this.#opts.newId?.() ?? `ra_${Date.now().toString(36)}_${++this.#counter}`;
    const done = this.#run(streamId, messageId, deviceId, options).catch((err: unknown) => {
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

  async #run(
    streamId: string,
    messageId: string,
    deviceId: string,
    options: { voice?: string; signal?: AbortSignal },
  ): Promise<LibraryItem> {
    const msg = await this.#opts.messages.get(messageId);
    const text = markdownToSpeech(msg.text);
    if (text === "") throw new PsycheError("invalid_params", "the message has nothing to read");
    if (text.length > (this.#opts.maxChars ?? READ_ALOUD_MAX_CHARS)) {
      throw new PsycheError("invalid_params", "the message is too long to read aloud");
    }
    const synth: { voice?: string; signal?: AbortSignal } = {};
    if (options.voice !== undefined) synth.voice = options.voice;
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
      if (format !== undefined && !sameFormat(format, chunk.format)) {
        throw new PsycheError("internal", "engine changed audio format mid-stream");
      }
      format = chunk.format;
      parts.push(chunk.data);
      // One chunk of look-ahead so the final event can carry `last: true`.
      send(false);
      pending = chunk;
    }
    send(true);
    if (options.signal?.aborted === true)
      throw new PsycheError("cancelled", "read-aloud cancelled");
    if (format === undefined) throw new PsycheError("internal", "the engine produced no audio");
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
      tags: ["read-aloud", `message:${messageId}`],
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
