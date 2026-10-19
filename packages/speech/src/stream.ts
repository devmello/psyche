import type { Transcript, TranscriptSegment } from "@psyche/protocol";

/**
 * Partial/final discipline every engine's stream goes through (architecture §5, dictation):
 *
 * - A final segment is committed text. Finals come out in time order and never overlap: a final
 *   that starts before the previous final ended is clamped to start there.
 * - A partial (`final: false`) is the volatile tail after the last final. A later partial or
 *   final replaces it. Repeated identical partials and empty partials are dropped.
 * - When the source ends with a partial still pending, `finish()` promotes it to a final, so the
 *   last thing a client sees is always a final (or nothing, for silence).
 */
export class SegmentSequencer {
  readonly #finals: TranscriptSegment[] = [];
  #pending: TranscriptSegment | undefined;
  #lastEmittedPartial: string | undefined;
  #finished = false;

  /** Feeds one engine segment; returns the segments to emit (zero or one). */
  push(segment: TranscriptSegment): TranscriptSegment[] {
    if (this.#finished) return [];
    const text = segment.text.trim();
    const floor = this.#finals.at(-1)?.endMs ?? 0;
    const startMs = Math.max(segment.startMs, floor);
    const endMs = Math.max(segment.endMs, startMs);
    if (!segment.final) {
      if (text === "" || text === this.#lastEmittedPartial) return [];
      const partial: TranscriptSegment = { text, startMs, endMs, final: false };
      if (segment.confidence !== undefined) partial.confidence = segment.confidence;
      this.#pending = partial;
      this.#lastEmittedPartial = text;
      return [partial];
    }
    this.#pending = undefined;
    this.#lastEmittedPartial = undefined;
    if (text === "") return [];
    const final: TranscriptSegment = { text, startMs, endMs, final: true };
    if (segment.confidence !== undefined) final.confidence = segment.confidence;
    this.#finals.push(final);
    return [final];
  }

  /** Ends the stream; promotes a pending partial to a final. Idempotent. */
  finish(): TranscriptSegment[] {
    if (this.#finished) return [];
    const pending = this.#pending;
    const out = pending === undefined ? [] : this.push({ ...pending, final: true });
    this.#finished = true;
    return out;
  }

  get finals(): readonly TranscriptSegment[] {
    return this.#finals;
  }

  transcript(language?: string): Transcript {
    const t: Transcript = { text: joinSegments(this.#finals), segments: [...this.#finals] };
    if (language !== undefined) t.language = language;
    return t;
  }
}

/** Joins final segment texts with single spaces (no space before closing punctuation). */
export function joinSegments(segments: readonly TranscriptSegment[]): string {
  let out = "";
  for (const s of segments) {
    const text = s.text.trim();
    if (text === "") continue;
    out = out === "" || /^[,.;:!?)'’”]/.test(text) ? `${out}${text}` : `${out} ${text}`;
  }
  return out;
}

/** Runs an engine's raw segment stream through a `SegmentSequencer`. */
export async function* sequenceSegments(
  source: AsyncIterable<TranscriptSegment>,
  signal?: AbortSignal,
): AsyncIterable<TranscriptSegment> {
  const seq = new SegmentSequencer();
  for await (const segment of source) {
    if (signal?.aborted === true) return;
    yield* seq.push(segment);
  }
  if (signal?.aborted === true) return;
  yield* seq.finish();
}
