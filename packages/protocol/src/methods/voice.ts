import { type Static, Type } from "@sinclair/typebox";
import { Id, Nullable, Provenance, StringEnum } from "../common.ts";
import { ErrorPayload } from "../errors.ts";
import { Block } from "../schemas/blocks.ts";
import { LibraryItem } from "../schemas/surfaces.ts";
import { Task } from "../schemas/tasks.ts";
import { defineMethod, OkResult } from "./define.ts";

/**
 * `voice.*` composer dictation, voice memos, `speech.readAloud` and `speech.voices` (feature
 * Q1, Q3, Q4; architecture §5, §11; owner S17, `packages/speech`). The desktop and web clients
 * capture audio and stream raw PCM chunks; segments come back as `voice.segment` events to the
 * starting device only. When the engine policy picks a client-side engine (Web Speech),
 * `voice.start` answers `location: "client"` with no session and the web client dictates
 * locally. A session started with `memo: true` keeps its audio so `voice.memo.save` can file it
 * as a Library recording with the transcript and, when the memo asks for one, a Task.
 *
 * Voice mode (feature Q5) is driven by the client from these pieces: a dictation session per
 * utterance, `chat.send`, the run's events, and `speech.readAloud {save: false}` for the reply,
 * stopped with `speech.readAloud.cancel` when the owner talks over it. Approvals stay cards; no
 * voice path answers them.
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

/** When a voice memo becomes a Task: `auto` only when it opens with a cue ("remind me to…"). */
export const MemoTaskMode = StringEnum(["auto", "always", "never"], { $id: "MemoTaskMode" });
export type MemoTaskMode = Static<typeof MemoTaskMode>;

/** What the memo pipeline found in the transcript; the text itself is quoted in `blocks`. */
export const VoiceMemoContent = Type.Object(
  {
    urls: Type.Array(Type.String(), { description: "URL-like strings in the memo; never fetched" }),
    instructionLike: Type.Boolean({
      description: "The memo reads like instructions to the agent; shown as a note, not obeyed",
    }),
    flags: Type.Array(Type.String(), {
      description: "Which patterns matched (override, secrecy, …)",
    }),
  },
  { $id: "VoiceMemoContent" },
);
export type VoiceMemoContent = Static<typeof VoiceMemoContent>;

/** One synthesis voice for Settings and the persona editor (feature Q3). */
export const SpeechVoice = Type.Object(
  {
    ref: Type.String({ description: "<engine>:<voice>, the form IDENTITY.md voice: takes" }),
    engine: Type.String(),
    location: SpeechEngineLocation,
    id: Type.String(),
    name: Type.String(),
    language: Type.String({ description: "BCP 47, or * for any" }),
    local: Type.Boolean(),
    default: Type.Boolean({ description: "The voice the settings or the persona select now" }),
    nonCommercial: Type.Optional(
      Type.Boolean({ description: "Apple Personal Voice: non-commercial use only" }),
    ),
  },
  { $id: "SpeechVoice" },
);
export type SpeechVoice = Static<typeof SpeechVoice>;

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
      memo: Type.Optional(
        Type.Boolean({
          description: "Keep the audio so voice.memo.save can file the session as a voice memo",
        }),
      ),
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
  "voice.memo.save": defineMethod({
    params: Type.Object({
      sessionId: SessionId,
      threadId: Type.Optional(Id),
      task: Type.Optional(MemoTaskMode),
    }),
    result: Type.Object({
      transcript: TranscriptSchema,
      item: LibraryItem,
      task: Nullable(Task),
      provenance: Provenance,
      content: VoiceMemoContent,
      blocks: Type.Array(Block, {
        description:
          "Quoted transcript, file and task blocks for the message that carries the memo",
      }),
      durationMs: Type.Integer({ minimum: 0 }),
    }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Side-effecting: ends a memo session (voice.start with memo: true), stores the audio as a Library recording with the transcript and creates a Task when asked; the transcript is content, never instructions.",
  }),
  "speech.voices": defineMethod({
    params: Type.Object({
      personaVoice: Type.Optional(
        Type.String({ maxLength: 128, description: "The persona's current <engine>:<voice>" }),
      ),
    }),
    result: Type.Object({
      voices: Type.Array(SpeechVoice),
      default: Nullable(Type.String()),
      unavailable: Type.Array(Type.String(), {
        description: "Synthesis engines in order that could not list voices now",
      }),
    }),
    scope: "operator.read",
    description:
      "Lists every synthesis voice the available engines offer as <engine>:<voice> refs, for voice selection per persona.",
  }),
  "speech.readAloud": defineMethod({
    params: Type.Object({
      messageId: Id,
      voice: Type.Optional(Type.String({ maxLength: 128, description: "<engine>:<voice>" })),
      save: Type.Optional(
        Type.Boolean({
          description:
            "Default true. false: stream speech.audio only, save no Library item and emit no speech.readAloud.completed (voice mode, feature Q5)",
        }),
      ),
    }),
    result: Type.Object({ streamId: Type.String({ minLength: 1, maxLength: 64 }) }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Side-effecting: reads a message aloud, streams speech.audio events and saves the clip as a Library audio item.",
  }),
  "speech.readAloud.cancel": defineMethod({
    params: Type.Object({ streamId: Type.String({ minLength: 1, maxLength: 64 }) }),
    result: OkResult,
    scope: "operator.write",
    description:
      "Stops one of the caller's read-aloud streams now (voice mode barge-in, feature Q5); nothing is saved and speech.readAloud.failed reports cancelled. Unknown or finished streams answer ok.",
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
