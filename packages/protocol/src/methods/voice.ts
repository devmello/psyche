import { type Static, Type } from "@sinclair/typebox";
import { Id, StringEnum } from "../common.ts";
import { ErrorPayload } from "../errors.ts";
import { LibraryItem } from "../schemas/surfaces.ts";
import { defineMethod, OkResult } from "./define.ts";

/**
 * `voice.*` composer dictation and `speech.readAloud` (feature Q1, Q3; architecture §5, §11;
 * owner S17, `packages/speech`). The desktop and web clients capture audio and stream raw PCM
 * chunks; segments come back as `voice.segment` events to the starting device only. When the
 * engine policy picks a client-side engine (Web Speech), `voice.start` answers
 * `location: "client"` with no session and the web client dictates locally.
 */

/** JSON form of the `AudioFormat` contract type (`contracts/SpeechEngine.ts`). */
export const AudioFormatSchema = Type.Object(
  {
    encoding: StringEnum(["pcm_s16le", "pcm_f32le", "opus", "mp3", "wav", "caf"]),
    sampleRate: Type.Integer({ minimum: 8_000, maximum: 192_000 }),
    channels: Type.Integer({ minimum: 1, maximum: 8 }),
  },
  { $id: "AudioFormat" },
);

export const TranscriptSegmentSchema = Type.Object(
  {
    text: Type.String(),
    startMs: Type.Integer({ minimum: 0 }),
    endMs: Type.Integer({ minimum: 0 }),
    final: Type.Boolean({ description: "false = volatile partial a later segment replaces" }),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { $id: "TranscriptSegment" },
);

export const TranscriptSchema = Type.Object(
  {
    text: Type.String(),
    segments: Type.Array(TranscriptSegmentSchema),
    language: Type.Optional(Type.String()),
  },
  { $id: "Transcript" },
);

export const SpeechEngineLocation = StringEnum(["node", "gateway", "client", "cloud"], {
  $id: "SpeechEngineLocation",
});
export type SpeechEngineLocation = Static<typeof SpeechEngineLocation>;

export const VoiceEndReason = StringEnum(["stopped", "cancelled", "timeout", "error"], {
  $id: "VoiceEndReason",
});
export type VoiceEndReason = Static<typeof VoiceEndReason>;

const SessionId = Type.String({ minLength: 1, maxLength: 64 });

export const VoiceMethods = {
  "voice.start": defineMethod({
    params: Type.Object({
      format: AudioFormatSchema,
      language: Type.Optional(Type.String({ maxLength: 35, description: "BCP 47" })),
      vocabulary: Type.Optional(
        Type.Array(Type.String({ maxLength: 48 }), {
          maxItems: 64,
          description: "Extra terms; merged with the agent name, contacts and recent topics",
        }),
      ),
      threadId: Type.Optional(Id),
    }),
    result: Type.Object({
      sessionId: Type.Union([SessionId, Type.Null()]),
      location: SpeechEngineLocation,
      engine: Type.String(),
    }),
    scope: "operator.write",
    description:
      "Starts a dictation session (raw PCM only); null sessionId + location client means dictate in the browser.",
  }),
  "voice.push": defineMethod({
    params: Type.Object({
      sessionId: SessionId,
      seq: Type.Integer({
        minimum: 0,
        description: "0, 1, 2… per session; out of order is rejected",
      }),
      audio: Type.String({ maxLength: 512_000, description: "Base64 PCM in the session format" }),
    }),
    result: Type.Object({}),
    scope: "operator.write",
    description: "Appends one audio chunk to the caller's dictation session.",
  }),
  "voice.stop": defineMethod({
    params: Type.Object({ sessionId: SessionId }),
    result: Type.Object({ transcript: TranscriptSchema }),
    scope: "operator.write",
    description: "Ends the audio and answers with the final transcript once the engine flushed.",
  }),
  "voice.cancel": defineMethod({
    params: Type.Object({ sessionId: SessionId }),
    result: OkResult,
    scope: "operator.write",
    description: "Cancels a dictation session without a final transcript.",
  }),
  "speech.readAloud": defineMethod({
    params: Type.Object({
      messageId: Id,
      voice: Type.Optional(Type.String({ maxLength: 128, description: "<engine>:<voice>" })),
    }),
    result: Type.Object({ streamId: Type.String({ minLength: 1, maxLength: 64 }) }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Side-effecting: reads a message aloud, streams speech.audio events and saves the clip as a Library audio item.",
  }),
} as const;

/** Event payloads (registered in `src/events.ts`). */
export const VoiceSegmentPayload = Type.Object({
  sessionId: SessionId,
  segment: TranscriptSegmentSchema,
});
export const VoiceEndedPayload = Type.Object({
  sessionId: SessionId,
  reason: VoiceEndReason,
  error: Type.Optional(ErrorPayload),
});
export const SpeechAudioPayload = Type.Object({
  streamId: Type.String({ minLength: 1 }),
  seq: Type.Integer({ minimum: 0 }),
  audio: Type.String({ description: "Base64 PCM" }),
  format: AudioFormatSchema,
  last: Type.Boolean(),
});
export const ReadAloudCompletedPayload = Type.Object({
  streamId: Type.String({ minLength: 1 }),
  messageId: Id,
  item: LibraryItem,
  durationMs: Type.Integer({ minimum: 0 }),
});
export const ReadAloudFailedPayload = Type.Object({
  streamId: Type.String({ minLength: 1 }),
  messageId: Id,
  error: ErrorPayload,
});
