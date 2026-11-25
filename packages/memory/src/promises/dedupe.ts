/**
 * Fuzzy dedupe for promises written without a model (design 3.4, rule 3): a new promise merges
 * into an open one only when the counterpart and direction match, the due dates are within two
 * days (or both missing), the two were made within 14 days of each other, and the content words
 * overlap enough. A middling overlap is queued for the next model batch as a `same_as` question.
 * Promises are never merged across counterparts or directions.
 */

const STOPWORDS: Record<string, string> = {
  en: "a an the to of for on in at by with and or but i ill me my we our you your it its this that these those will would can could shall should please be is are am was were do does did have has had get got let lets just also then than so about up out over from into as if not no yes ok okay",
  de: "der die das den dem des ein eine einen einem einer und oder aber ich du er sie es wir ihr zu von mit für auf in an bei nach um wird werde kann könnte bitte ist sind war hat habe haben nicht kurz noch auch dann",
  es: "el la los las un una unos unas y o pero yo tu te me mi nos de del a en con por para que se es son fue ha he han no lo le les voy va vamos puedo puede favor también luego",
  fr: "le la les un une des et ou mais je tu il elle nous vous ils de du au aux à en dans avec pour par que se est sont été a ai ont ne pas ce cette vais va peux peut svp aussi puis",
  it: "il lo la i gli le un una e o ma io tu lui lei noi voi di del al in con per che si è sono ho ha hanno non vado va posso può favore anche poi",
  pt: "o a os as um uma e ou mas eu tu ele ela nós de do da em no na com por para que se é são foi há não vou vai posso pode favor também depois",
};
const STOP = new Set(
  Object.values(STOPWORDS)
    .flatMap((s) => s.split(/\s+/))
    .map((w) => w.normalize("NFKC")),
);

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Lowercased content words; CJK runs become character bigrams (no spaces to split on). */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  const tokens = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== "");
  for (const t of tokens) {
    if (CJK.test(t)) {
      const chars = [...t];
      if (chars.length === 1) out.add(t);
      for (let i = 0; i + 1 < chars.length; i += 1)
        out.add((chars[i] ?? "") + (chars[i + 1] ?? ""));
      continue;
    }
    if (t.length < 2 || STOP.has(t)) continue;
    out.add(t);
  }
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export interface DedupeCandidate {
  direction: "i_owe" | "waiting_on";
  counterpartId: string | null;
  text: string;
  dueAt: string | null;
  createdAtMs: number;
}

export const MERGE_JACCARD = 0.5;
export const ASK_JACCARD = 0.25;
export const DUE_WINDOW_DAYS = 2;
export const CREATED_WINDOW_DAYS = 14;
const DAY = 86_400_000;

export type DedupeVerdict = "merge" | "ask" | "distinct";

export function fuzzyVerdict(a: DedupeCandidate, b: DedupeCandidate): DedupeVerdict {
  if (a.direction !== b.direction) return "distinct";
  if (a.counterpartId === null || a.counterpartId !== b.counterpartId) return "distinct";
  if (Math.abs(a.createdAtMs - b.createdAtMs) > CREATED_WINDOW_DAYS * DAY) return "distinct";
  const da = a.dueAt === null ? null : Date.parse(a.dueAt);
  const db = b.dueAt === null ? null : Date.parse(b.dueAt);
  if ((da === null) !== (db === null)) return "distinct";
  if (da !== null && db !== null && Math.abs(da - db) > DUE_WINDOW_DAYS * DAY) return "distinct";
  const j = jaccard(contentWords(a.text), contentWords(b.text));
  if (j >= MERGE_JACCARD) return "merge";
  if (j >= ASK_JACCARD) return "ask";
  return "distinct";
}
