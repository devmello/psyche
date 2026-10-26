import { t } from "../i18n/core.ts";

/**
 * The phrase list from the active catalogue that says a request is about the screen, "|"-separated
 * so each language lists what its speakers say.
 */
export type VoicePhraseList = "screen";

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

/** Scripts written without spaces between words: a phrase matches anywhere in the text. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/**
 * Whether a request reads as being about what's on screen (Ask about my screen §3.3): it uses
 * one of the active language's `voice.phrases.screen` words ("this", "on screen", "what am I
 * looking at"). Then the screenshot goes with it; otherwise only the text context does, and the
 * agent can still look (`screen.look`), so a miss here is safe.
 */
export function mentionsScreen(text: string): boolean {
  const said = normalizeUtterance(text);
  if (said === "") return false;
  const padded = ` ${said} `;
  return voicePhrases("screen").some((p) => {
    const phrase = normalizeUtterance(p);
    if (phrase === "") return false;
    return UNSPACED.test(phrase) ? said.includes(phrase) : padded.includes(` ${phrase} `);
  });
}
