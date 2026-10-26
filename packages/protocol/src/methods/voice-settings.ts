/**
 * Owner settings for "Talk with Psyche" (Settings → Voice & dictation). Voice is speech to text:
 * hold the voice key (never the dictation key), speak, and the answer appears as text in the ask
 * panel. Psyche does not speak, so there is no voice, speed, narration or spoken approval.
 */
export const VOICE_CONVERSATION_SETTING_KEYS = {
  enabled: "voice.conversation.enabled",
  key: "voice.conversation.key",
  reviewBeforeSend: "voice.conversation.reviewBeforeSend",
} as const;
