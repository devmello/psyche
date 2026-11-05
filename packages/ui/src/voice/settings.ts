import {
  type DictationKey,
  defaultHoldKeys,
  VOICE_CONVERSATION_SETTING_KEYS as K,
} from "@psyche/protocol";
import { isWindows } from "../lib/platform.ts";
import { holdKeysHere } from "./hold-keys.ts";

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

/** The Mac's voice keys; Windows reads its own names too (`voice/hold-keys.ts`). */
export const VOICE_KEYS: readonly DictationKey[] = ["fn", "rightOption", "rightCommand"];

export function readVoiceSettings(values: Readonly<Record<string, unknown>>): VoiceSettings {
  const key = values[K.key];
  return {
    enabled: values[K.enabled] === true,
    // Right ⌘ on a Mac; Right Alt on Windows, where dictation defaults to Right Ctrl.
    key: holdKeysHere().find((k) => k === key) ?? defaultHoldKeys(isWindows()).voice,
    reviewBeforeSend: values[K.reviewBeforeSend] === true,
  };
}
