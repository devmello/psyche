import { sha256Hex } from "./support.ts";

/**
 * Forget everywhere (memory wave 3A). One phrase, one matching rule, every store.
 *
 * The rule is the one `SqliteMemoryStore.forget` always used: the phrase as a whole word or
 * phrase, case-insensitive, with any run of spaces standing for `\s+`. `Jordan` matches "Jordan",
 * "jordan's" and "Jordan Lee", never "Jordana" or "Jordanian". Letters and digits (any script)
 * end a word.
 */

export const MIN_FORGET_CHARS = 3;

/** A forgotten phrase and the pattern that matches it (no `g` flag, so `test` is stateless). */
export interface ForgetMatcher {
  readonly phrase: string;
  readonly pattern: RegExp;
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Scripts written without spaces between words: a phrase that starts or ends in one cannot be
 * bounded by "the next character is not a letter" (`和李明一起` holds `李明`), so no boundary is
 * asked on that side.
 */
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

export function forgetMatcher(subject: string): ForgetMatcher {
  const phrase = oneLine(subject);
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  const chars = [...phrase];
  const before = UNSPACED.test(chars[0] ?? "") ? "" : "(?<![\\p{L}\\p{N}])";
  const after = UNSPACED.test(chars.at(-1) ?? "") ? "" : "(?![\\p{L}\\p{N}])";
  return { phrase, pattern: new RegExp(`${before}${escaped}${after}`, "iu") };
}

/** Whether `text` mentions the phrase. `null` and `undefined` never do. */
export const mentions = (m: ForgetMatcher, text: string | null | undefined): boolean =>
  typeof text === "string" && text.length > 0 && m.pattern.test(text);

/**
 * Rows deleted (or, on a preview, that would be deleted) per store. Every number is what the
 * forget removes from that store, so a preview and the forget that follows report the same
 * counts. Stores that cannot be counted are listed in `UNCOUNTED_FORGET_STORES`.
 */
export type ForgetCounts = {
  /** Workspace Markdown files that lose lines (daily notes, MEMORY.md, USER.md, people cards...). */
  markdownFiles: number;
  /** Lines (daily-note entries count once) removed from those files. */
  markdownLines: number;
  /** Claims retracted: text and sources are erased, the id and dates stay. */
  claims: number;
  /** Indexed chunks (and their vectors) removed, including those of persona and protected files. */
  chunks: number;
  /** People, organisations and projects deleted with everything attached to them. */
  graphEntities: number;
  /** Graph facts deleted: every version of a matching fact, superseded and retracted ones too. */
  graphFacts: number;
  /** Graph relations deleted (a matching citation, or a deleted entity's). */
  graphEdges: number;
  /** Open loops and promises deleted. */
  graphLoops: number;
  /** Mail, message and note records whose subject or gist is blanked (the record stays). */
  graphInteractions: number;
  /** Citations (the quoted evidence of a fact) deleted. */
  graphCitations: number;
  /** Other graph text blanked: summaries, notes, merge suggestions, anchors, hints. */
  graphOther: number;
  /** Facts and relations waiting in the Memory review tab that are deleted. */
  reviewItems: number;
  /** Quarantined items whose excerpt is erased (the row stays so the item is not read again). */
  quarantine: number;
  /** Lessons forgotten (a tombstone keeps only the id, kind and a hash). */
  lessons: number;
  /** Lesson lines removed from AGENTS.md and skills' LESSONS.md. */
  lessonLines: number;
  /** Feedback events (the owner's corrections) deleted. */
  feedback: number;
  /** Memory documents removed from the search index. */
  searchDocs: number;
};

export const FORGET_COUNT_KEYS = [
  "markdownFiles",
  "markdownLines",
  "claims",
  "chunks",
  "graphEntities",
  "graphFacts",
  "graphEdges",
  "graphLoops",
  "graphInteractions",
  "graphCitations",
  "graphOther",
  "reviewItems",
  "quarantine",
  "lessons",
  "lessonLines",
  "feedback",
  "searchDocs",
] as const satisfies readonly (keyof ForgetCounts)[];

/**
 * Stores the forget cleans but cannot count: the run traces and saved chats are rewritten in the
 * background (`onForget`), their payloads are compressed.
 */
export const UNCOUNTED_FORGET_STORES = ["runTraces", "savedChats"] as const;

export const emptyForgetCounts = (): ForgetCounts => ({
  markdownFiles: 0,
  markdownLines: 0,
  claims: 0,
  chunks: 0,
  graphEntities: 0,
  graphFacts: 0,
  graphEdges: 0,
  graphLoops: 0,
  graphInteractions: 0,
  graphCitations: 0,
  graphOther: 0,
  reviewItems: 0,
  quarantine: 0,
  lessons: 0,
  lessonLines: 0,
  feedback: 0,
  searchDocs: 0,
});

export const forgetTotal = (c: ForgetCounts): number =>
  FORGET_COUNT_KEYS.reduce((n, k) => n + c[k], 0);

export function addForgetCounts(a: ForgetCounts, b: Partial<ForgetCounts>): ForgetCounts {
  const out = { ...a };
  for (const k of FORGET_COUNT_KEYS) out[k] += b[k] ?? 0;
  return out;
}

/**
 * The stores outside the Markdown workspace and the index, owned by the Gateway (graph, lessons,
 * search). `preview` counts, `apply` deletes and returns the same numbers.
 */
export interface ForgetCascade {
  preview(m: ForgetMatcher): Promise<Partial<ForgetCounts>>;
  apply(m: ForgetMatcher): Promise<Partial<ForgetCounts>>;
}

// --- hashed suppression of persona chunks -----------------------------------------------------

const WORD = /[\p{L}\p{N}]+/gu;

/** The words of a text, lower-cased and NFKC-folded. */
export const wordsOf = (text: string): string[] =>
  (text.normalize("NFKC").toLowerCase().match(WORD) ?? []).slice(0, 5_000);

/** Hash of a phrase's words; the phrase itself is never stored. */
export const phraseHash = (words: readonly string[]): string => sha256Hex(words.join(" "));

export interface Suppression {
  /** Number of words in the phrase (or of characters, with `c`). */
  k: number;
  h: string;
  /** Matched by a window of characters: the phrase has a script written without spaces. */
  c?: 1;
}

export const MAX_SUPPRESSIONS = 500;

const charsOf = (text: string): string[] => [...text.normalize("NFKC").toLowerCase()];

/** The suppression entry for a phrase, or undefined when it has no word to match on. */
export function suppressionFor(phrase: string): Suppression | undefined {
  if (UNSPACED.test(phrase)) {
    const chars = charsOf(phrase.replace(/\s+/g, " ").trim());
    return chars.length === 0 || chars.length > 60
      ? undefined
      : { k: chars.length, h: sha256Hex(chars.join("")), c: 1 };
  }
  const words = wordsOf(phrase);
  return words.length === 0 || words.length > 12
    ? undefined
    : { k: words.length, h: phraseHash(words) };
}

/** Whether `text` holds one of the suppressed phrases as a run of whole words. */
export function isSuppressed(text: string, list: readonly Suppression[]): boolean {
  if (list.length === 0) return false;
  const words = wordsOf(text);
  for (const k of new Set(list.filter((s) => s.c !== 1).map((s) => s.k))) {
    const hashes = new Set(list.filter((s) => s.c !== 1 && s.k === k).map((s) => s.h));
    for (let i = 0; i + k <= words.length; i++) {
      if (hashes.has(phraseHash(words.slice(i, i + k)))) return true;
    }
  }
  const chars = list.some((s) => s.c === 1) ? charsOf(text) : [];
  for (const k of new Set(list.filter((s) => s.c === 1).map((s) => s.k))) {
    const hashes = new Set(list.filter((s) => s.c === 1 && s.k === k).map((s) => s.h));
    for (let i = 0; i + k <= chars.length; i++) {
      if (hashes.has(sha256Hex(chars.slice(i, i + k).join("")))) return true;
    }
  }
  return false;
}
