import { t } from "../i18n/core.ts";

/**
 * The spoken phrase lists (docs/voice/voice-mode-2026.md §4.3, §4.6) from the active catalogue:
 * approve and deny for approvals by voice, and the trailing words that lengthen the end-of-turn
 * hangover. "|"-separated in the catalogue so each language lists what its speakers say.
 */
export type VoicePhraseList = "approve" | "deny" | "trailing";

export function voicePhrases(list: VoicePhraseList): string[] {
  return t(`voice.phrases.${list}`)
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

/** Lower case, typographic apostrophes straightened, punctuation and extra spaces dropped. */
export function normalizeUtterance(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Which phrase list an utterance matches exactly (after normalisation), or null. */
export function matchApproval(text: string): "approve" | "deny" | null {
  const said = normalizeUtterance(text);
  if (said === "") return null;
  const hit = (list: VoicePhraseList) =>
    voicePhrases(list).some((p) => normalizeUtterance(p) === said);
  if (hit("deny")) return "deny";
  if (hit("approve")) return "approve";
  return null;
}
