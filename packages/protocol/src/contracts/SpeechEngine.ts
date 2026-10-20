import type { CallOptions } from "./Clock.ts";

/**
 * Speech engine contract (feature Q1, N11; architecture §5 dictation, §6 `speech.*`; owner S17).
 * Engines: SpeechAnalyzer via the Mac node, whisper.cpp on the Gateway, Web Speech in the web
 * client; Kokoro / cloud voices for synthesis.
 */

export interface AudioFormat {
  encoding: "pcm_s16le" | "pcm_f32le" | "opus" | "mp3" | "wav" | "caf";
  sampleRate: number;
  channels: number;
}

export interface TranscribeOptions extends CallOptions {
  language?: string;
  /** Custom vocabulary (agent name, contacts, recent topics). */
  vocabulary?: string[];
}

export interface TranscriptSegment {
  text: string;
  startMs: number;
  endMs: number;
  /** `false` = volatile partial that a later segment may replace. */
  final: boolean;
  confidence?: number;
}

export interface Transcript {
  text: string;
  segments: TranscriptSegment[];
  language?: string;
}

export interface Voice {
  id: string;
  name: string;
  language: string;
  local: boolean;
  /** Apple Personal Voice (the helper's `personalVoice`): non-commercial use only. */
  nonCommercial?: boolean;
}

export interface SynthesizeOptions extends CallOptions {
  voice?: string;
  format?: AudioFormat;
}

export interface AudioChunk {
  data: Uint8Array;
  format: AudioFormat;
}

export interface SpeechCapabilities {
  engine: string;
  streaming: boolean;
  synthesis: boolean;
  languages: string[];
}

export interface SpeechEngine {
  capabilities(): Promise<SpeechCapabilities>;
  transcribeStream(
    audio: AsyncIterable<Uint8Array>,
    format: AudioFormat,
    options?: TranscribeOptions,
  ): AsyncIterable<TranscriptSegment>;
  transcribeFile(
    data: Uint8Array,
    format: AudioFormat,
    options?: TranscribeOptions,
  ): Promise<Transcript>;
  synthesize(text: string, options?: SynthesizeOptions): AsyncIterable<AudioChunk>;
  voices(): Promise<Voice[]>;
}
