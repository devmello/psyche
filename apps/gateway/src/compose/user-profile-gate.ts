/**
 * The deterministic pre-gate of the chat learner (memory audit P7). It runs before any model
 * call: a message that states nothing about the owner never costs one. It is deliberately loose
 * (a cheap model still decides, under a daily cap) and language-aware enough for the ten UI
 * languages: Latin-script languages have their own first-person cues, and any message that
 * contains letters of another script (Arabic, Devanagari, Han, Kana, Hangul, Cyrillic, ...) passes
 * to the model rather than being blocked outright.
 */

/** A word-bounded alternation that also works next to accented letters. */
const words = (alternatives: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives})(?![\\p{L}\\p{N}_])`, "iu");

/** First-person cues, per Latin-script UI language (English first). */
const CUES: readonly RegExp[] = [
  // English
  words(
    [
      "my",
      "mine",
      "myself",
      "i['’]m",
      "im",
      "i am",
      "i['’]ve been",
      "i live",
      "i work",
      "i study",
      "i prefer",
      "i like",
      "i love",
      "i hate",
      "i enjoy",
      "i usually",
      "i always",
      "i never",
      "i don['’]?t",
      "i do not",
      "i can['’]t stand",
      "i was born",
      "i grew up",
      "i moved",
      "i speak",
      "i go to",
      "we live",
      "call me",
      "remember",
      "for future reference",
      "from now on",
      "going forward",
    ].join("|"),
  ),
  // Spanish
  words(
    "mi|mis|me llamo|soy|vivo|trabajo|estudio|prefiero|me gusta|me encanta|no me gusta|recuerda|acuérdate|llámame|nací",
  ),
  // French
  words(
    "mon|ma|mes|je suis|j['’](?:habite|aime|adore|étudie)|je (?:vis|travaille|préfère|déteste|m['’]appelle)|appelle-moi|souviens-toi|rappelle-toi|n['’]oublie pas",
  ),
  // German
  words(
    "mein|meine|meinen|meinem|meiner|ich bin|ich wohne|ich arbeite|ich studiere|ich mag|ich liebe|ich hasse|ich lebe|ich bevorzuge|nenn mich|nennen sie mich|merk dir|denk daran",
  ),
  // Italian
  words(
    "mio|mia|miei|mie|sono|abito|vivo|lavoro|studio|preferisco|mi piace|non mi piace|chiamami|ricorda|ricordati",
  ),
  // Portuguese
  words(
    "meu|minha|meus|minhas|eu sou|moro|trabalho|estudo|prefiro|gosto|não gosto|me chame|lembre|lembra-te",
  ),
];

/** Letters of any script other than Latin: the message is not English or a Latin-script UI language. */
const NON_LATIN_LETTER = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

const FENCE = /```[\s\S]*?(?:```|$)/g;
const CODE_LINE =
  /[;{}]\s*$|^\s*(?:import |export |const |let |var |def |class |function |return\b|#include|<\/?[a-z][\w-]*[ >/]|at \S+ \(|\$ )/;

/** A code paste, a stack trace or a log: fenced blocks only, or most lines look like source. */
export function looksLikeCode(text: string): boolean {
  const rest = text.replace(FENCE, "").trim();
  if (rest === "" && text.trim() !== "") return true;
  const lines = rest.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 3) return false;
  return lines.filter((l) => CODE_LINE.test(l)).length / lines.length >= 0.5;
}

/**
 * Whether a message may hold a fact about the owner and is worth a model call: first-person cues,
 * a work hint, an attachment, or text in a script the cues do not cover.
 */
export function learnGate(
  text: string,
  opts: { attached?: boolean; work?: boolean } = {},
): boolean {
  const t = text.trim();
  if (t.length < 8) return false;
  if (opts.attached === true) return true;
  if (looksLikeCode(t)) return false;
  const prose = t.replace(FENCE, " ");
  if (NON_LATIN_LETTER.test(prose)) return true;
  if (opts.work === true) return true;
  return CUES.some((re) => re.test(prose));
}
