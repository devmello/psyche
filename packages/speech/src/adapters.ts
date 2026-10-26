import {
  type AudioFormat,
  PsycheError,
  type SpeechCapabilities,
  type SpeechEngine,
  type TranscribeOptions,
  type Transcript,
  type TranscriptSegment,
} from "@psyche/protocol";
import { decodeWav, isPcm, PCM_16K_MONO } from "./audio.ts";
import type { VoiceNoteTranscoder } from "./transcode/ffmpeg.ts";

/**
 * Glue for inbound voice notes on a channel (N11 / Q4): the channel service hands a voice note to
 * `SpeechEngine.transcribeFile(data, {encoding: "opus", …})`. Psyche does not send voice notes.
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
}
