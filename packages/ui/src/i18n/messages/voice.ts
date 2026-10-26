/**
 * Voice conversation (docs/voice/voice-mode-2026.md §4.5, §4.6, §4.10, §6): the capsule, the
 * lantern's states, the HUD, Settings → Voice conversation and the onboarding line.
 */
export const voice = {
  "voice.key.fn": "fn",
  "voice.key.rightOption": "Right ⌥",
  "voice.key.rightCommand": "Right ⌘",

  "voice.settings.title": "Voice conversation",
  "voice.settings.enabled": "Talk with Psyche",
  "voice.settings.enabledHint":
    "Hold the voice key in any app, or tap Voice in the chat, and talk.",
  "voice.settings.key": "Voice key",
  "voice.settings.keyHint": "It must differ from the dictation key.",
  "voice.settings.keyClash": "That's the dictation key. Pick another one.",
  "voice.settings.review": "Review before sending",
  "voice.settings.reviewHint": "Shows what Psyche heard so you can fix it before it goes.",

  "voice.onboarding.hint": "Hold {key} to talk to {name}.",

  // What Psyche says (§4.5, §4.6): fixed templates the Gateway fills, never model text.
  // Phrase lists (§4.3, §4.6), "|"-separated, matched after normalisation. Translate the
  // phrases people say in each language; keep the "|" separators.
  // Ask about my screen: words that mean the request is about what's on screen.
  "voice.phrases.screen":
    "this|that|these|those|here|on screen|on my screen|looking at|what am i looking at|this page|this error|this chart|this window|above|below",
} as const;
