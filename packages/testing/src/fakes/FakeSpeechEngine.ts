import type {
  AudioChunk,
  AudioFormat,
  SpeechCapabilities,
  SpeechEngine,
  SynthesizeOptions,
  TranscribeOptions,
  Transcript,
  TranscriptSegment,
  Voice,
} from "@psyche/protocol";

const PCM_16K: AudioFormat = { encoding: "pcm_s16le", sampleRate: 16_000, channels: 1 };

/**
 * Scripted speech engine. `transcript(text)` sets what the next transcription "hears": the
 * stream emits one volatile partial per word and a final segment per audio chunk boundary;
 * `synthesize` emits silent PCM sized by text length (10 ms per character).
 */
export class FakeSpeechEngine implements SpeechEngine {
  #next = "hello world";
  readonly synthesized: string[] = [];

  transcript(text: string): this {
    this.#next = text;
    return this;
  }

  async capabilities(): Promise<SpeechCapabilities> {
    return { engine: "fake", streaming: true, synthesis: true, languages: ["en"] };
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

  async *synthesize(text: string, options: SynthesizeOptions = {}): AsyncIterable<AudioChunk> {
    this.synthesized.push(text);
    const format = options.format ?? PCM_16K;
    const bytes = Math.max(2, Math.round((text.length * 10 * format.sampleRate * 2) / 1000));
    const chunk = 3200;
    for (let off = 0; off < bytes; off += chunk) {
      if (options.signal?.aborted === true) return;
      yield { data: new Uint8Array(Math.min(chunk, bytes - off)), format };
    }
  }

  async voices(): Promise<Voice[]> {
    return [{ id: "fake-en", name: "Fake", language: "en", local: true }];
  }
}
