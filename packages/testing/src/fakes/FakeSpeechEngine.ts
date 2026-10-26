import type {
  AudioFormat,
  SpeechCapabilities,
  SpeechEngine,
  TranscribeOptions,
  Transcript,
  TranscriptSegment,
} from "@psyche/protocol";

/**
 * Scripted speech engine. `transcript(text)` sets what the next transcription "hears": the
 * stream emits one volatile partial per word and a final segment per audio chunk boundary.
 */
export class FakeSpeechEngine implements SpeechEngine {
  #next = "hello world";

  transcript(text: string): this {
    this.#next = text;
    return this;
  }

  async capabilities(): Promise<SpeechCapabilities> {
    return { engine: "fake", streaming: true, languages: ["en"] };
  }

  async *transcribeStream(
    audio: AsyncIterable<Uint8Array>,
    _format: AudioFormat,
    options: TranscribeOptions = {},
  ): AsyncIterable<TranscriptSegment> {
    for await (const _chunk of audio) {
      if (options.signal?.aborted === true) return;
    }
    const words = this.#next.split(/\s+/).filter(Boolean);
    let partial = "";
    for (const [i, w] of words.entries()) {
      partial = partial === "" ? w : `${partial} ${w}`;
      yield { text: partial, startMs: 0, endMs: (i + 1) * 300, final: false };
    }
    yield {
      text: this.#next,
      startMs: 0,
      endMs: words.length * 300,
      final: true,
      confidence: 0.99,
    };
  }

  async transcribeFile(
    _data: Uint8Array,
    _format: AudioFormat,
    _options?: TranscribeOptions,
  ): Promise<Transcript> {
    const words = this.#next.split(/\s+/).filter(Boolean);
    return {
      text: this.#next,
      language: "en",
      segments: [{ text: this.#next, startMs: 0, endMs: words.length * 300, final: true }],
    };
  }
}
