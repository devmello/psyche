import {
  type DictationKey,
  VOICE_CONVERSATION_SETTING_KEYS as K,
  type VoiceApprovalTier,
  type VoiceConversationMode,
  type VoiceNarrateLevel,
  type VoiceSpeakLevel,
} from "@psyche/protocol";

/**
 * Settings → Voice & dictation → Voice conversation (docs/voice/voice-mode-2026.md §6.4), with
 * every value defaulted and the #481 (Q5) keys migrated: the old `voice.conversation.start`
 * "toggle" becomes hands-free and "push" stays push; `voice.conversation.reply` is dropped.
 */

export type VoiceBrief = "off" | "listen" | "atMac";

export interface VoiceSettings {
  enabled: boolean;
  key: DictationKey;
  mode: VoiceConversationMode;
  /** `<engine>:<voice>`, or null for the best installed voice for the language. */
  voice: string | null;
  rate: number;
  speak: VoiceSpeakLevel;
  narrate: VoiceNarrateLevel;
  bargeIn: boolean;
  approvals: VoiceApprovalTier;
  /** BCP 47, or null to follow the app's language. */
  language: string | null;
  captions: boolean;
  reviewBeforeSend: boolean;
  pauseMs: number;
  brief: VoiceBrief;
}

export const VOICE_DEFAULTS: VoiceSettings = {
  enabled: false,
  key: "rightCommand",
  mode: "push",
  voice: null,
  rate: 1,
  speak: "brief",
  narrate: "brief",
  bargeIn: true,
  approvals: "write",
  language: null,
  captions: true,
  reviewBeforeSend: false,
  pauseMs: 600,
  brief: "listen",
};

/** The #481 key that chose the turn style before §6.4. */
export const LEGACY_START_KEY = "voice.conversation.start";

export const VOICE_RATE = { min: 0.8, max: 1.5, step: 0.05 } as const;
export const VOICE_PAUSE_MS = { min: 500, max: 2000 } as const;

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

export function readVoiceSettings(values: Readonly<Record<string, unknown>>): VoiceSettings {
  const legacy = values[LEGACY_START_KEY];
  const legacyMode: VoiceConversationMode | undefined =
    legacy === "toggle" ? "handsfree" : legacy === "push" ? "push" : undefined;
  return {
    enabled: values[K.enabled] === true,
    key: pick(values[K.key], ["fn", "rightOption", "rightCommand"], VOICE_DEFAULTS.key),
    mode: pick(values[K.mode], ["push", "tap", "handsfree"], legacyMode ?? VOICE_DEFAULTS.mode),
    voice:
      typeof values[K.voice] === "string" && values[K.voice] !== ""
        ? (values[K.voice] as string)
        : null,
    rate: clamp(values[K.rate], VOICE_RATE.min, VOICE_RATE.max, VOICE_DEFAULTS.rate),
    speak: pick(values[K.speak], ["brief", "full"], VOICE_DEFAULTS.speak),
    narrate: pick(values[K.narrate], ["off", "brief", "steps"], VOICE_DEFAULTS.narrate),
    bargeIn: values[K.bargeIn] !== false,
    approvals: pick(
      values[K.approvals],
      ["off", "write", "write_destructive"],
      VOICE_DEFAULTS.approvals,
    ),
    language:
      typeof values[K.language] === "string" && values[K.language] !== ""
        ? (values[K.language] as string)
        : null,
    captions: values[K.captions] !== false,
    reviewBeforeSend: values[K.reviewBeforeSend] === true,
    pauseMs: clamp(
      values[K.pauseMs],
      VOICE_PAUSE_MS.min,
      VOICE_PAUSE_MS.max,
      VOICE_DEFAULTS.pauseMs,
    ),
    brief: pick(values[K.brief], ["off", "listen", "atMac"], VOICE_DEFAULTS.brief),
  };
}

/** The writes that move a #481 owner onto §6.4's keys (empty once migrated). */
export function migrateVoiceSettings(
  values: Readonly<Record<string, unknown>>,
): { key: string; value: unknown }[] {
  const legacy = values[LEGACY_START_KEY];
  if (values[K.mode] !== undefined || (legacy !== "toggle" && legacy !== "push")) return [];
  return [{ key: K.mode, value: legacy === "toggle" ? "handsfree" : "push" }];
}
