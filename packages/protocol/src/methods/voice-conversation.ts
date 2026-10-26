import { type Static, Type } from "@sinclair/typebox";
import { Id, StringEnum } from "../common.ts";
import { ErrorPayload } from "../errors.ts";
import { ToolCallStatus } from "../schemas/blocks.ts";
import { defineMethod, OkResult } from "./define.ts";
import { AudioFormatSchema, SpeechEngineLocation } from "./voice.ts";

/**
 * `voice.conversation.*`: the Gateway-owned voice conversation (feature Q5;
 * docs/voice/voice-mode-2026.md §4, §7; owner S17, `packages/speech`).
 *
 * The Gateway runs the turns. It transcribes the owner's speech, sends it to the agent loop as a
 * `via: "voice"` owner message, and speaks the reply sentence by sentence while the model
 * streams. It narrates slow tool steps from their labels, and reads approvals back for a spoken
 * answer within chat's tiers. Clients are audio terminals:
 * - they capture the microphone (with echo cancellation) and stream it with `audio`;
 * - they mark push-to-talk with `turn`;
 * - they detect barge-in and report it with `interrupt`;
 * - they play `voice.conversation.speech` and report what was heard with `played`;
 * - they draw `state`, `caption` and `step`.
 *
 * Every event goes to the starting device only. A conversation belongs to one thread and one
 * device; another device's id is treated as unknown. None of these methods is side-effecting in
 * the idempotency sense: the owner messages and approval answers they cause are recorded by the
 * Gateway under its own keys.
 */

const ConversationId = Type.String({ minLength: 1, maxLength: 64 });
const UtteranceId = Type.String({ minLength: 1, maxLength: 64 });

/** How the owner's turns end (spec §4.1): key up, a pause after a tap, or a pause, hands-free. */
export const VoiceConversationMode = StringEnum(["push", "tap", "handsfree"], {
  $id: "VoiceConversationMode",
});
export type VoiceConversationMode = Static<typeof VoiceConversationMode>;

export const VoiceConversationPhase = StringEnum(
  ["listening", "heard", "thinking", "speaking", "waiting", "ended"],
  { $id: "VoiceConversationPhase" },
);
export type VoiceConversationPhase = Static<typeof VoiceConversationPhase>;

export const VoiceConversationEndReason = StringEnum(
  ["stopped", "idle", "locked", "error", "disconnected"],
  { $id: "VoiceConversationEndReason" },
);
export type VoiceConversationEndReason = Static<typeof VoiceConversationEndReason>;

/** How much of an answer is spoken (spec §4.5). */
export const VoiceSpeakLevel = StringEnum(["brief", "full"], { $id: "VoiceSpeakLevel" });
export type VoiceSpeakLevel = Static<typeof VoiceSpeakLevel>;

/** Tool-step narration (spec §4.5): none, one phrase for slow steps, or every step. */
export const VoiceNarrateLevel = StringEnum(["off", "brief", "steps"], {
  $id: "VoiceNarrateLevel",
});
export type VoiceNarrateLevel = Static<typeof VoiceNarrateLevel>;

/** Which approvals voice may answer (spec §4.6); `deviceOnly` kinds never. */
export const VoiceApprovalTier = StringEnum(["off", "write", "write_destructive"], {
  $id: "VoiceApprovalTier",
});
export type VoiceApprovalTier = Static<typeof VoiceApprovalTier>;

/** Push-to-talk key down / up, or a tap (`voice.conversation.turn`). */
export const VoiceTurnAction = StringEnum(["begin", "end"], { $id: "VoiceTurnAction" });
export type VoiceTurnAction = Static<typeof VoiceTurnAction>;

/** What the owner did with a reviewed transcript (`voice.conversation.review`). */
export const VoiceReviewAction = StringEnum(["send", "discard"], { $id: "VoiceReviewAction" });
export type VoiceReviewAction = Static<typeof VoiceReviewAction>;

/** The longest transcript a review shows or sends back (about five minutes of speech). */
export const VOICE_REVIEW_MAX_CHARS = 8_000;

/** Barge-in stage (`voice.conversation.interrupt`). */
export const VoiceInterruptStage = StringEnum(["suspect", "confirmed"], {
  $id: "VoiceInterruptStage",
  description:
    "suspect: the client VAD heard speech and ducked playback; confirmed: a key press stopped it",
});
export type VoiceInterruptStage = Static<typeof VoiceInterruptStage>;

/** Why a conversation is in its phase (`voice.conversation.state.reason`). */
export const VoiceConversationReason = StringEnum(
  ["approval", "question", "barge_in", "no_speech", "review"],
  {
    $id: "VoiceConversationReason",
    description:
      "Waiting for an approval or a question, a confirmed barge-in, nothing heard, or the owner reviewing their words before they are sent",
  },
);
export type VoiceConversationReason = Static<typeof VoiceConversationReason>;

/**
 * Who a caption belongs to. No `$id` on purpose: quicktype merges enums with the same values, and
 * an id here would rename the existing Swift enum with these values (custom connectors' `drafted`).
 */
export const VoiceCaptionRole = StringEnum(["owner", "agent"]);
export type VoiceCaptionRole = Static<typeof VoiceCaptionRole>;

/** Owner settings for voice conversation (spec §6.4); the Gateway reads them per conversation. */
export const VOICE_CONVERSATION_SETTING_KEYS = {
  enabled: "voice.conversation.enabled",
  key: "voice.conversation.key",
  mode: "voice.conversation.mode",
  voice: "voice.conversation.voice",
  rate: "voice.conversation.rate",
  speak: "voice.conversation.speak",
  narrate: "voice.conversation.narrate",
  bargeIn: "voice.conversation.bargeIn",
  approvals: "voice.conversation.approvals",
  language: "voice.conversation.language",
  captions: "voice.conversation.captions",
  reviewBeforeSend: "voice.conversation.reviewBeforeSend",
  pauseMs: "voice.conversation.pauseMs",
  brief: "voice.conversation.brief",
} as const;

export const VoiceConversationMethods = {
  "voice.conversation.start": defineMethod({
    params: Type.Object({
      threadId: Type.Optional(Id),
      mode: VoiceConversationMode,
      format: AudioFormatSchema,
      language: Type.Optional(Type.String({ maxLength: 35, description: "BCP 47" })),
      voice: Type.Optional(Type.String({ maxLength: 128, description: "<engine>:<voice>" })),
    }),
    result: Type.Object({
      conversationId: ConversationId,
      engine: Type.String(),
      location: SpeechEngineLocation,
    }),
    scope: "operator.write",
    description:
      "Starts a voice conversation on a thread (default: the main thread), one per device; the Gateway runs the turns and speaks the replies.",
  }),
  "voice.conversation.audio": defineMethod({
    params: Type.Object({
      conversationId: ConversationId,
      seq: Type.Integer({ minimum: 0, description: "0, 1, 2… per conversation; in order" }),
      audio: Type.String({ maxLength: 512_000, description: "Base64 PCM in the start format" }),
    }),
    result: Type.Object({}),
    scope: "operator.write",
    description: "Appends microphone audio to the caller's voice conversation.",
  }),
  "voice.conversation.turn": defineMethod({
    params: Type.Object({
      conversationId: ConversationId,
      action: VoiceTurnAction,
    }),
    result: Type.Object({}),
    scope: "operator.write",
    description: "Push-to-talk key down (begin) or up (end), or a tap that opens or ends a turn.",
  }),
  "voice.conversation.interrupt": defineMethod({
    params: Type.Object({
      conversationId: ConversationId,
      stage: VoiceInterruptStage,
      playedMs: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    result: Type.Object({}),
    scope: "operator.write",
    description:
      "Barge-in: the Gateway confirms a suspect with a transcribed word (or releases it) and stops speaking on a confirmation.",
  }),
  "voice.conversation.played": defineMethod({
    params: Type.Object({
      conversationId: ConversationId,
      utteranceId: UtteranceId,
      playedMs: Type.Integer({ minimum: 0 }),
      done: Type.Boolean({ description: "The utterance played to its end" }),
    }),
    result: Type.Object({}),
    scope: "operator.write",
    description: "Reports how much of a spoken utterance the owner heard.",
  }),
  "voice.conversation.review": defineMethod({
    params: Type.Object({
      conversationId: ConversationId,
      utteranceId: UtteranceId,
      action: VoiceReviewAction,
      text: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: VOICE_REVIEW_MAX_CHARS,
          description: "The edited transcript to send; omitted, the draft is sent as heard",
        }),
      ),
    }),
    result: Type.Object({}),
    scope: "operator.write",
    description:
      "Review before sending (spec §4.10): sends the owner's reviewed words as the voice turn, or discards them. Only for the draft the Gateway is waiting on (state reason review).",
  }),
  "voice.conversation.stop": defineMethod({
    params: Type.Object({ conversationId: ConversationId }),
    result: OkResult,
    scope: "operator.write",
    description: "Ends the caller's voice conversation; speech stops and the microphone closes.",
  }),
} as const;

/** Event payloads (registered in `src/events.ts`). */
export const VoiceConversationStatePayload = Type.Object({
  conversationId: ConversationId,
  phase: VoiceConversationPhase,
  reason: Type.Optional(VoiceConversationReason),
  approvalId: Type.Optional(Id),
  /** While waiting for a spoken answer: the readback that was spoken, for the caption. */
  prompt: Type.Optional(Type.String({ maxLength: 600 })),
  /** While waiting for a spoken answer: how long the listening window stays open. */
  windowMs: Type.Optional(Type.Integer({ minimum: 0 })),
  /** Whether the microphone audio is being transcribed (the "Mic on" chip). */
  listening: Type.Boolean(),
  /**
   * Review before sending (`reason: "review"`): the transcript waiting for the owner to edit and
   * send with `voice.conversation.review`, and the caption's utterance it belongs to.
   */
  draft: Type.Optional(Type.String({ maxLength: VOICE_REVIEW_MAX_CHARS })),
  utteranceId: Type.Optional(UtteranceId),
});
export const VoiceConversationCaptionPayload = Type.Object({
  conversationId: ConversationId,
  role: VoiceCaptionRole,
  utteranceId: UtteranceId,
  text: Type.String(),
  final: Type.Boolean(),
});
export const VoiceConversationSpeechPayload = Type.Object({
  conversationId: ConversationId,
  utteranceId: UtteranceId,
  seq: Type.Integer({ minimum: 0 }),
  audio: Type.String({ description: "Base64 PCM" }),
  format: AudioFormatSchema,
  last: Type.Boolean({ description: "The utterance's last chunk" }),
});
export const VoiceConversationStepPayload = Type.Object({
  conversationId: ConversationId,
  toolCallId: Id,
  label: Type.String({ maxLength: 200, description: "The narration text as shown" }),
  status: ToolCallStatus,
});
export const VoiceConversationEndedPayload = Type.Object({
  conversationId: ConversationId,
  reason: VoiceConversationEndReason,
  error: Type.Optional(ErrorPayload),
});
