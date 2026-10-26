import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "../common.ts";

/**
 * The mac helper's `speech.*` node capabilities for dictation (owner S14 helper, S17 Gateway):
 * `preset` on `speech.transcribe_stream` and the timings `speech.status` reports. These shapes
 * describe helper capabilities and register no client methods. Psyche does not speak, so the
 * helper has no synthesis, voices or Personal Voice.
 */

/** `speech.transcribe_stream` preset: long dictation (default) or short turns (H3). */
export const SpeechTranscribePreset = StringEnum(["long", "short"], {
  $id: "SpeechTranscribePreset",
});
export type SpeechTranscribePreset = Static<typeof SpeechTranscribePreset>;

/** Timings the helper reports in `speech.status` (median of recent calls; absent until measured). */
export const HelperSpeechTimings = Type.Object(
  {
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
