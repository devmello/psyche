import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "../common.ts";

/**
 * The mac helper's `speech.*` node capabilities for voice conversation (docs/voice/voice-mode-2026.md
 * §8 V-H; owner S14 helper, S17 Gateway). These shapes mirror what the helper accepts today and
 * add the fields V-H implements: `speech.prepare` (H2), `speed` and `utteranceId` on
 * `speech.synthesize` (H2), voice details on `speech.voices` (H2), `preset` on
 * `speech.transcribe_stream` (H3) and `speech.personal_voice.authorize` (H4). Every addition is
 * optional, so a helper without it keeps working; the Gateway checks `speech.status` first.
 */

export const SpeechPcmEncoding = StringEnum(["pcm_s16le", "pcm_f32le"], {
  $id: "SpeechPcmEncoding",
});
export type SpeechPcmEncoding = Static<typeof SpeechPcmEncoding>;

export const SpeechVoiceQuality = StringEnum(["default", "enhanced", "premium"], {
  $id: "SpeechVoiceQuality",
});
export type SpeechVoiceQuality = Static<typeof SpeechVoiceQuality>;

/** One `speech.voices` entry. */
export const HelperSpeechVoice = Type.Object(
  {
    id: Type.String({ description: "AVSpeechSynthesisVoice identifier" }),
    name: Type.String(),
    language: Type.String({ description: "BCP 47" }),
    quality: SpeechVoiceQuality,
    personalVoice: Type.Boolean({ description: "Apple Personal Voice: non-commercial use only" }),
    installed: Type.Optional(
      Type.Boolean({
        description: "The voice's assets are on disk (premium voices need a download)",
      }),
    ),
  },
  { $id: "HelperSpeechVoice" },
);
export type HelperSpeechVoice = Static<typeof HelperSpeechVoice>;

/** `speech.synthesize` params. */
export const HelperSynthesizeParams = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 5_000 }),
    voice: Type.Optional(
      Type.String({ maxLength: 256, description: "Voice id from speech.voices" }),
    ),
    rate: Type.Optional(
      Type.Number({ minimum: 0, maximum: 1, description: "0 slowest … 1 fastest; 0.5 ≈ normal" }),
    ),
    speed: Type.Optional(
      Type.Number({
        minimum: 0.5,
        maximum: 2,
        description: "Multiplier of the voice's normal rate (1 = normal); wins over rate",
      }),
    ),
    personalVoice: Type.Optional(
      Type.Boolean({ description: "Opt in to the owner's Personal Voice" }),
    ),
    format: Type.Optional(SpeechPcmEncoding),
    utteranceId: Type.Optional(
      Type.String({ maxLength: 64, description: "Echoed on every speech.audio event" }),
    ),
  },
  { $id: "HelperSynthesizeParams" },
);
export type HelperSynthesizeParams = Static<typeof HelperSynthesizeParams>;

/** `speech.prepare`: keep a synthesizer warm for a voice so the first sentence starts fast. */
export const HelperSpeechPrepareParams = Type.Object(
  {
    voice: Type.Optional(Type.String({ maxLength: 256 })),
    language: Type.Optional(Type.String({ maxLength: 35 })),
    keepWarmMs: Type.Optional(
      Type.Integer({
        minimum: 1_000,
        maximum: 600_000,
        description: "How long to keep it warm without use (default 120 000)",
      }),
    ),
  },
  { $id: "HelperSpeechPrepareParams" },
);
export type HelperSpeechPrepareParams = Static<typeof HelperSpeechPrepareParams>;

export const HelperSpeechPrepareResult = Type.Object(
  {
    voice: Type.String({ description: "The voice id that was prepared" }),
    prepared: Type.Boolean(),
    prepareMs: Type.Integer({ minimum: 0 }),
  },
  { $id: "HelperSpeechPrepareResult" },
);
export type HelperSpeechPrepareResult = Static<typeof HelperSpeechPrepareResult>;

/** `speech.transcribe_stream` preset: long dictation (default) or short turns (H3). */
export const SpeechTranscribePreset = StringEnum(["long", "short"], {
  $id: "SpeechTranscribePreset",
});
export type SpeechTranscribePreset = Static<typeof SpeechTranscribePreset>;

/** `speech.personal_voice.authorize`: asks macOS once, only on an explicit owner action. */
export const PersonalVoiceAuthorization = StringEnum(
  ["authorized", "denied", "notDetermined", "unsupported"],
  { $id: "PersonalVoiceAuthorization" },
);
export type PersonalVoiceAuthorization = Static<typeof PersonalVoiceAuthorization>;

/** Timings the helper reports in `speech.status` (median of recent calls; absent until measured). */
export const HelperSpeechTimings = Type.Object(
  {
    synthesisFirstAudioMs: Type.Optional(Type.Integer({ minimum: 0 })),
    firstPartialMs: Type.Optional(
      Type.Object({
        long: Type.Optional(Type.Integer({ minimum: 0 })),
        short: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
    ),
    finalizeMs: Type.Optional(
      Type.Object({
        long: Type.Optional(Type.Integer({ minimum: 0 })),
        short: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
    ),
  },
  { $id: "HelperSpeechTimings" },
);
export type HelperSpeechTimings = Static<typeof HelperSpeechTimings>;
