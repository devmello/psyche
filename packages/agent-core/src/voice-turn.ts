import type { ContextSection, ModelRef, VoiceTurnOptions } from "@psyche/protocol";

/**
 * Voice turns (docs/voice/voice-mode-2026.md §4.5): the owner spoke, and the Gateway speaks the
 * answer's lead. This section asks for an answer written for the ear first, with the details after
 * a blank line, where they are shown and not spoken. It is fixed text, not model or owner input.
 */

/** The router's role refs: a voice turn moves `router/primary` to `router/voice`. */
export const PRIMARY_ROLE_REF: ModelRef = "router/primary";
export const VOICE_ROLE_REF: ModelRef = "router/voice";

export const VOICE_TURN_TEXT =
  "This turn is spoken. Start with a direct answer of one to three short, plain sentences, as you would say it aloud: no lists, Markdown, code or URLs in that part. Put details after a blank line; they are shown, not spoken. If a tool will take a while, say what you are doing in one short sentence. Never say something is done before the tool reports success.";

export function voiceTurnSection(voice: VoiceTurnOptions): ContextSection {
  const language = voice.language?.replace(/[^A-Za-z0-9-]/g, "").slice(0, 35);
  const text =
    voice.speak === "full"
      ? VOICE_TURN_TEXT.replace(
          "Put details after a blank line; they are shown, not spoken.",
          "Keep the whole answer speakable: short paragraphs, no tables or code.",
        )
      : VOICE_TURN_TEXT;
  return {
    id: "voice",
    kind: "base",
    title: "Voice turn",
    text: language ? `${text} Answer in the language with BCP 47 tag ${language}.` : text,
  };
}
