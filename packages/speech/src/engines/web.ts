import type { TranscriptSegment } from "@psyche/protocol";
import type { EngineEntry } from "../policy.ts";
import { AsyncQueue } from "../queue.ts";
import { SegmentSequencer } from "../stream.ts";

/**
 * Web Speech in the web client: the last-resort dictation engine (architecture §5, 06 §5).
 * The browser captures the microphone itself and the API cannot take audio chunks, so this is a
 * client-side helper rather than a Gateway `SpeechEngine`: `voice.start` answers
 * `{location: "client", engine: "web-speech"}` and psyche-web runs `webSpeechDictation`.
 * In Chrome the audio goes to Google's recognizer, which the Settings copy must say. Electron
 * has no Web Speech backend, so the desktop never selects it (the policy's `client_only` rule).
 *
 * Types are local (no DOM lib in this package); they match the WHATWG Speech API draft.
 */

export interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}
export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}
export interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { readonly length: number; [index: number]: SpeechRecognitionResultLike };
}
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** The selector entry the Gateway registers for Web Speech (never runs server-side). */
export const WEB_SPEECH_ENTRY: EngineEntry = {
  id: "web-speech",
  location: "client",
  supports: { transcribe: false, stream: true },
  available: async () => true,
};

export interface WebDictation {
  segments: AsyncIterable<TranscriptSegment>;
  /** Finishes: pending speech is finalized, then the iteration ends. */
  stop(): void;
  /** Cancels without a final. */
  abort(): void;
}

/**
 * Starts browser dictation. Interim results become volatile partials, final results become
 * finals, both through the same `SegmentSequencer` every engine uses. `now` gives elapsed ms.
 */
export function webSpeechDictation(
  Recognition: SpeechRecognitionCtor,
  options: { language?: string; now?: () => number } = {},
): WebDictation {
  const rec = new Recognition();
  const queue = new AsyncQueue<TranscriptSegment>();
  const seq = new SegmentSequencer();
  const t0 = options.now?.() ?? Date.now();
  const elapsed = () => (options.now?.() ?? Date.now()) - t0;
  let lastFinalEnd = 0;
  let aborted = false;

  rec.lang = options.language ?? "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const alt = r?.[0];
      if (r === undefined || alt === undefined) continue;
      if (r.isFinal) {
        const end = elapsed();
        for (const s of seq.push({
          text: alt.transcript,
          startMs: lastFinalEnd,
          endMs: end,
          final: true,
          confidence: alt.confidence,
        })) {
          queue.push(s);
        }
        lastFinalEnd = end;
      } else {
        interim += alt.transcript;
      }
    }
    if (interim !== "") {
      for (const s of seq.push({
        text: interim,
        startMs: lastFinalEnd,
        endMs: elapsed(),
        final: false,
      })) {
        queue.push(s);
      }
    }
  };
  rec.onerror = (e) => {
    if (e.error === "aborted" || e.error === "no-speech") return;
    queue.fail(new Error(`web speech: ${e.error}`));
  };
  rec.onend = () => {
    if (!aborted) for (const s of seq.finish()) queue.push(s);
    queue.end();
  };
  rec.start();
  return {
    segments: queue,
    stop: () => rec.stop(),
    abort: () => {
      aborted = true;
      rec.abort();
    },
  };
}
