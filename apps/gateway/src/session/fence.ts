/**
 * Keeps a third party's file from writing the markers that frame an attachment. Matching is done
 * on a normalised copy (NFKD, invisible and combining characters dropped, blank fillers read as spaces, look-alike Latin letters from
 * Cyrillic and Greek folded, runs of whitespace collapsed), then the opening bracket of every
 * match is swapped, in the ORIGINAL text, for a full-width lookalike. One UTF-16 unit becomes one,
 * so lengths and budgets do not change and nothing else in the text is touched.
 */

const FULLWIDTH_BRACKET = "［";

/** Letters that read as Latin in the marker words but are not (the usual homoglyphs). */
const LOOKALIKES: Readonly<Record<string, string>> = {
  а: "a", // Cyrillic а
  е: "e", // Cyrillic е
  о: "o", // Cyrillic о
  с: "c", // Cyrillic с
  р: "p", // Cyrillic р
  і: "i", // Cyrillic і
  ѕ: "s", // Cyrillic ѕ
  ԁ: "d", // Cyrillic ԁ
  х: "x", // Cyrillic х
  у: "y", // Cyrillic у
  т: "t", // Cyrillic т
  н: "h", // Cyrillic н
  ο: "o", // Greek ο
  α: "a", // Greek α
  ε: "e", // Greek ε
  ι: "i", // Greek ι
  τ: "t", // Greek τ
  υ: "u", // Greek υ
  // Small capitals
  "\u1D00": "a",
  "\u0299": "b",
  "\u1D04": "c",
  "\u1D05": "d",
  "\u1D07": "e",
  "\uA730": "f",
  "\u0262": "g",
  "\u029C": "h",
  "\u026A": "i",
  "\u1D0A": "j",
  "\u1D0B": "k",
  "\u029F": "l",
  "\u1D0D": "m",
  "\u0274": "n",
  "\u1D0F": "o",
  "\u1D18": "p",
  "\u0280": "r",
  "\uA731": "s",
  "\u1D1B": "t",
  "\u1D1C": "u",
  "\u1D20": "v",
  "\u1D21": "w",
  "\u028F": "y",
  "\u1D22": "z",
  // Armenian
  "\u0585": "o",
  "\u057D": "u",
};

/** Marker words after the opening bracket, on the normalised copy (lower case, single spaces). */
const MARKER =
  /[[\u27E6] ?(?:end[ _-]*of\b|untrusted ?:|attached[ _-]*(?:file|image|library|item))/g;

export function defangFence(text: string): string {
  if (!text.includes("[") && !/\P{ASCII}/u.test(text)) return text;
  let norm = "";
  const origin: number[] = []; // norm index -> UTF-16 index of the original character
  let at = 0;
  for (const ch of text) {
    const start = at;
    at += ch.length;
    for (const piece of ch.normalize("NFKD")) {
      // Blank fillers count as spaces, so "end<filler>of" reads as "end of".
      const blank = piece === "\u2800" || piece === "\u3164" || /\s/u.test(piece);
      // Format characters, combining marks and other default-ignorable code points are invisible.
      if (!blank && /[\p{Cf}\p{M}\p{Default_Ignorable_Code_Point}]/u.test(piece)) continue;
      let c = LOOKALIKES[piece.toLowerCase()] ?? piece;
      if (blank) {
        if (norm.endsWith(" ")) continue;
        c = " ";
      }
      for (const u of c.toLowerCase()) {
        norm += u;
        for (let k = 0; k < u.length; k++) origin.push(start);
      }
    }
  }
  const chars = text.split("");
  for (const m of norm.matchAll(MARKER)) {
    const i = origin[m.index ?? 0];
    if (i !== undefined) chars[i] = FULLWIDTH_BRACKET;
  }
  return chars.join("");
}
