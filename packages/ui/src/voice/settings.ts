import { type DictationKey, VOICE_CONVERSATION_SETTING_KEYS as K } from "@psyche/protocol";

/**
 * Settings → Voice & dictation → Talk with Psyche. Voice is speech-to-text into the pop-up chat
 * (docs/voice/voice-mode-2026.md, amended): the owner holds a key, speaks, and the answer appears
 * as text. Psyche does not speak, so there is no voice, speed, narration, barge-in, readback or
 * spoken brief; the Gateway removes those stale keys.
 */

export interface VoiceSettings {
  enabled: boolean;
  /** The voice key, held to talk from any app; never the dictation key. */
  key: DictationKey;
  /** Show the dictated words for editing before they are sent. */
  reviewBeforeSend: boolean;
}

export const VOICE_DEFAULTS: VoiceSettings = {
  enabled: false,
  key: "rightCommand",
  reviewBeforeSend: false,
};

export const VOICE_KEYS: readonly DictationKey[] = ["fn", "rightOption", "rightCommand"];

export function readVoiceSettings(values: Readonly<Record<string, unknown>>): VoiceSettings {
  const key = values[K.key];
  return {
    enabled: values[K.enabled] === true,
    key: VOICE_KEYS.find((k) => k === key) ?? VOICE_DEFAULTS.key,
    reviewBeforeSend: values[K.reviewBeforeSend] === true,
  };
}
