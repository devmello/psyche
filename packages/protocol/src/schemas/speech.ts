import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "../common.ts";
import { TranscriptSegmentSchema } from "../methods/voice.ts";
import type { NodeCapability } from "./identity.ts";

/**
 * Long-form transcription on the Mac (docs/workflows/mail-and-meetings-2026.md §4.6, §8.4; #673).
 * The mac helper's `speech.transcribe_file` node capability transcribes an audio file in a granted
 * folder or the Library on device: SpeechAnalyzer, chunked at about 10 minutes with a short overlap,
 * at most 4 hours. It streams `speech.progress` events and returns the whole transcript. A meeting
 * transcript is other people's words: the caller stores it as `untrusted` unless the owner is the
 * only speaker. Added by S14 (H).
 */

/** The longest audio `speech.transcribe_file` accepts: 4 hours. */
export const SPEECH_FILE_MAX_DURATION_MS = 4 * 60 * 60 * 1000;

/** The on-device engine that produced a transcript (the helper's `SpeechEngineKind`). */
export const SpeechNodeEngine = StringEnum(["speechAnalyzer", "dictationTranscriber", "sfSpeech"], {
  $id: "SpeechNodeEngine",
});
export type SpeechNodeEngine = Static<typeof SpeechNodeEngine>;

/** `speech.transcribe_file` params. */
export const SpeechTranscribeFileParams = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: 4096,
      description:
        "Absolute path of an audio file in a granted folder or the Library (m4a, caf, wav, aiff, mp3, …)",
    }),
    locale: Type.Optional(
      Type.String({ maxLength: 35, description: "BCP-47 tag (default: the Mac's locale)" }),
    ),
    vocabulary: Type.Optional(
      Type.Array(Type.String({ maxLength: 64 }), {
        maxItems: 100,
        description: "Names and terms; selects DictationTranscriber with contextual strings",
      }),
    ),
    maxDurationMs: Type.Optional(
      Type.Integer({
        minimum: 1000,
        maximum: SPEECH_FILE_MAX_DURATION_MS,
        description: "Refuse longer files (default and ceiling 4 h)",
      }),
    ),
  },
  { $id: "SpeechTranscribeFileParams", additionalProperties: false },
);
export type SpeechTranscribeFileParams = Static<typeof SpeechTranscribeFileParams>;

/** `speech.transcribe_file` result: segment times are from the start of the file. */
export const SpeechTranscribeFileResult = Type.Object(
  {
    text: Type.String(),
    segments: Type.Array(TranscriptSegmentSchema, { description: "Final segments in time order" }),
    engine: SpeechNodeEngine,
    language: Type.String({ description: "BCP-47 tag of the locale used" }),
    audioMs: Type.Integer({ minimum: 0, description: "Duration of the file" }),
    chunks: Type.Integer({ minimum: 1, description: "How many chunks the file was split into" }),
  },
  { $id: "SpeechTranscribeFileResult" },
);
export type SpeechTranscribeFileResult = Static<typeof SpeechTranscribeFileResult>;

/**
 * `node.event` data streamed by `speech.transcribe_file`: one after each chunk (and one at 0 when
 * it starts). `speech.model_download` events may come first while system speech assets install.
 */
export const SpeechProgressEvent = Type.Object(
  {
    type: Type.Literal("speech.progress"),
    processedMs: Type.Integer({ minimum: 0, description: "Audio transcribed so far" }),
    totalMs: Type.Integer({ minimum: 0 }),
    fraction: Type.Number({ minimum: 0, maximum: 1 }),
    chunk: Type.Integer({ minimum: 0, description: "Chunks finished" }),
    chunks: Type.Integer({ minimum: 1 }),
  },
  { $id: "SpeechProgressEvent" },
);
export type SpeechProgressEvent = Static<typeof SpeechProgressEvent>;

/** The long-form capability the mac helper declares (its manifest matches). */
export const SPEECH_FILE_CAPABILITIES: readonly NodeCapability[] = [
  {
    name: "speech.transcribe_file",
    description:
      "Transcribe an audio file in a granted folder or the Library on device (≤ 4 h), streaming speech.progress",
    sideEffect: "read",
    targetKind: "path",
    streaming: true,
  },
];
