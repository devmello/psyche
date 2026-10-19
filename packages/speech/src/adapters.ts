import {
  type AudioChunk,
  type AudioFormat,
  type ChannelType,
  PsycheError,
  type SpeechCapabilities,
  type SpeechEngine,
  type SynthesizeOptions,
  type TranscribeOptions,
  type Transcript,
  type TranscriptSegment,
  type Voice,
} from "@psyche/protocol";
import { decodeWav, isPcm, PCM_16K_MONO } from "./audio.ts";
import type { VoiceNoteTranscoder } from "./transcode/ffmpeg.ts";
import {
  profileFor,
  VOICE_NOTE_PROFILES,
  type VoiceNoteContainer,
  type VoiceNoteProfile,
} from "./transcode/formats.ts";

/**
 * Glue for the N11 / Q4 round trip on a channel (Telegram first): the channel service hands an
 * inbound voice note to `SpeechEngine.transcribeFile(data, {encoding: "opus", …})` and asks a
 * `VoiceTranscoder`-shaped port for outbound notes per container. Both shapes are owned by
 * `packages/channels`; this file satisfies them without importing that package.
 */

/**
 * A `SpeechEngine` that accepts compressed input: Opus, MP3 and CAF are decoded with ffmpeg to
 * 16 kHz mono PCM and WAV is unwrapped before the wrapped engine sees them; raw PCM passes
 * through untouched. `createSpeechStack().engine` is wrapped this way.
 */
export class DecodingSpeechEngine implements SpeechEngine {
  readonly #engine: SpeechEngine;
  readonly #transcoder: VoiceNoteTranscoder;

  constructor(engine: SpeechEngine, transcoder: VoiceNoteTranscoder) {
    this.#engine = engine;
    this.#transcoder = transcoder;
  }

  capabilities(): Promise<SpeechCapabilities> {
    return this.#engine.capabilities();
  }

  transcribeStream(
    audio: AsyncIterable<Uint8Array>,
    format: AudioFormat,
    options?: TranscribeOptions,
  ): AsyncIterable<TranscriptSegment> {
    return this.#engine.transcribeStream(audio, format, options);
  }

  async transcribeFile(
    data: Uint8Array,
    format: AudioFormat,
    options: TranscribeOptions = {},
  ): Promise<Transcript> {
    if (isPcm(format)) return this.#engine.transcribeFile(data, format, options);
    if (format.encoding === "wav") {
      const wav = decodeWav(data);
      if (wav === undefined) throw new PsycheError("invalid_params", "not a PCM WAV file");
      return this.#engine.transcribeFile(wav.data, wav.format, options);
    }
    if (!(await this.#transcoder.available())) {
      throw new PsycheError("unavailable", `cannot decode ${format.encoding} without ffmpeg`, {
        retryable: true,
      });
    }
    const pcm = await this.#transcoder.decode(
      data,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    return this.#engine.transcribeFile(pcm, PCM_16K_MONO, options);
  }

  synthesize(text: string, options?: SynthesizeOptions): AsyncIterable<AudioChunk> {
    return this.#engine.synthesize(text, options);
  }

  voices(): Promise<Voice[]> {
    return this.#engine.voices();
  }
}

/** The channel package's outbound port (`VoiceTranscoder` in `packages/channels/src/voice.ts`). */
export interface ChannelVoiceTranscoder {
  transcode(
    pcm: Uint8Array,
    format: AudioFormat,
    target: VoiceNoteContainer | ChannelType,
  ): Promise<{ data: Uint8Array; mime: string; name: string; durationMs: number }>;
}

/** Per container, the profile with the largest cap; a channel target enforces its own cap. */
const CONTAINER_PROFILES: Record<VoiceNoteContainer, VoiceNoteProfile> = {
  ogg_opus: VOICE_NOTE_PROFILES.signal,
  caf_opus: VOICE_NOTE_PROFILES.imessage,
  mp3: VOICE_NOTE_PROFILES.slack,
};

/**
 * Adapts `VoiceNoteTranscoder.encode` to the channel service's `VoiceTranscoder` port
 * (`FakeVoiceTranscoder` stands in there until this is wired). Pass a `ChannelType` to get that
 * channel's size cap and file name; a bare container uses its most permissive profile.
 */
export function channelVoiceTranscoder(transcoder: VoiceNoteTranscoder): ChannelVoiceTranscoder {
  return {
    async transcode(pcm, format, target) {
      const profile =
        target in CONTAINER_PROFILES
          ? CONTAINER_PROFILES[target as VoiceNoteContainer]
          : profileFor(target as ChannelType);
      const enc = await transcoder.encode(pcm, format, profile);
      return { data: enc.data, mime: enc.mime, name: enc.fileName, durationMs: enc.durationMs };
    },
  };
}
