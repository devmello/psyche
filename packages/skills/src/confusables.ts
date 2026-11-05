/**
 * A confusable skeleton for author names, in the spirit of Unicode TR39: two names that look
 * alike to a person reduce to the same string. The full `confusables.txt` is not shipped (no
 * dependency for one comparison); this table covers the Latin look-alikes in Cyrillic, Greek,
 * Armenian and the IPA block, the digits and signs people swap for letters, and the common
 * letter pairs (`rn` for `m`, `vv` for `w`, `cl` for `d`). Compatibility forms (fullwidth, math
 * alphanumerics, ligatures, superscripts) are folded by NFKC before this table is consulted, and
 * combining marks are dropped. It is a warning aid, not a proof of difference: names that match
 * here are flagged, names that do not are still shown to the owner as the author's own claim.
 */
const GROUPS: Record<string, string> = {
  a: "аɑαạаӑӓ4@",
  b: "ЬьвβƅƄ68ḃ",
  c: "сϲᴄⅽϛς¢ċ",
  d: "ԁɗⅾԃḋ",
  e: "еєεҽɛℯ3éёė",
  g: "ɡġցգ9",
  h: "һհнηℎ",
  // i, l, 1, | and ! are one class: they are the same stroke in most typefaces.
  l: "ilііıɩιⅰⅼӏǀ|!1ℓ¡ɪӀ",
  j: "јϳʝ",
  k: "кκⱪ",
  m: "мⅿʍ",
  n: "ηոռпⁿ",
  o: "оοσօ0ⲟ°ơöøծ",
  p: "рρⲣ",
  q: "ԛգ",
  r: "гʀ",
  s: "ѕʂ5$ṣ",
  t: "тτ7ţ",
  u: "υսμυцü",
  v: "νѵⅴ",
  w: "ԝѡա",
  x: "хχⅹ×",
  y: "уγʏүỵ",
  z: "ᴢʐ2",
};

const MAP = new Map<string, string>();
for (const [latin, lookalikes] of Object.entries(GROUPS))
  for (const ch of lookalikes) MAP.set(ch, latin);

/** Letters pairs that read as one, applied after the per-character map. */
const PAIRS: [RegExp, string][] = [
  [/rn/g, "m"],
  [/vv/g, "w"],
  [/cl/g, "d"],
];

/** Normalized for comparison: NFKC, case-folded, trimmed, whitespace collapsed. */
export function normalizeAuthorName(name: string): string {
  return name
    .normalize("NFKC")
    .toUpperCase()
    .toLowerCase()
    .replace(/[\s\u200b-\u200f]+/g, " ")
    .trim();
}

/**
 * The skeleton of a name: normalized, diacritics dropped, look-alike characters mapped to one
 * Latin form, letter pairs joined, and everything that is not a letter or digit removed.
 * "Ada Lovelace", "ada  lovelace", "Аdа Lovelace" (Cyrillic а), "4da L0velace" and
 * "Ada Lovelace" with a fullwidth A share one skeleton.
 */
export function authorNameSkeleton(name: string): string {
  const base = normalizeAuthorName(name)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
  let out = "";
  for (const ch of base) {
    const m = MAP.get(ch) ?? ch;
    if (/[\p{L}\p{N}]/u.test(m)) out += m;
  }
  for (const [re, to] of PAIRS) out = out.replace(re, to);
  return out;
}
