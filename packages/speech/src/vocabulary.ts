/**
 * Custom vocabulary for dictation (feature Q1): the agent's name, the owner's contacts and
 * recent topics bias recognition toward words a generic model spells wrong ("Pip", "Okonkwo",
 * "sqlite-vec"). Each engine consumes the list its own way: SpeechAnalyzer's
 * `contextualStrings`, whisper.cpp's initial `--prompt`, Web Speech's (rarely honored) grammar.
 */

export interface VocabularySources {
  /** The agent's name from IDENTITY.md (always first). */
  agentName?: string;
  ownerName?: string;
  /** Words the owner added in Settings → Voice & dictation. */
  custom?: readonly string[];
  /** Contact display names (connector or Apple Contacts cache). */
  contacts?: readonly string[];
  /** Recent topics or entity names from memory, newest first. */
  topics?: readonly string[];
}

export const VOCABULARY_MAX_TERMS = 64;
export const VOCABULARY_MAX_TERM_CHARS = 48;
/** whisper.cpp keeps at most n_text_ctx/2 = 224 prompt tokens; ~600 chars stays under that. */
export const WHISPER_PROMPT_MAX_CHARS = 600;

/** Normalizes one term; `undefined` when it should be dropped. */
function clean(term: string): string | undefined {
  const t = [...term]
    .map((ch) => {
      const c = ch.charCodeAt(0);
      return c < 0x20 || c === 0x7f ? " " : ch;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (t === "" || t.length > VOCABULARY_MAX_TERM_CHARS) return undefined;
  // Placeholders and markup never belong in a recognizer prompt.
  if (t.includes("{{") || t.includes("}}") || /[<>]/.test(t)) return undefined;
  return t;
}

/**
 * Builds the vocabulary list in priority order (agent name, owner, custom, contacts, topics),
 * de-duplicated case-insensitively and capped at `max` terms.
 */
export function buildVocabulary(
  sources: VocabularySources,
  max: number = VOCABULARY_MAX_TERMS,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined) => {
    if (raw === undefined || out.length >= max) return;
    const t = clean(raw);
    if (t === undefined) return;
    const key = t.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  add(sources.agentName);
  add(sources.ownerName);
  for (const t of sources.custom ?? []) add(t);
  for (const t of sources.contacts ?? []) add(t);
  for (const t of sources.topics ?? []) add(t);
  return out;
}

/** Merges a request's vocabulary with the session default, request terms first. */
export function mergeVocabulary(...lists: (readonly string[] | undefined)[]): string[] {
  return buildVocabulary({ custom: lists.flatMap((l) => l ?? []) });
}

/**
 * Renders vocabulary as a whisper.cpp initial prompt. Whisper continues the style of its prompt,
 * so a plain comma-separated glossary sentence works better than instructions.
 */
export function whisperPrompt(
  vocabulary: readonly string[] | undefined,
  maxChars: number = WHISPER_PROMPT_MAX_CHARS,
): string | undefined {
  const terms = buildVocabulary({ custom: vocabulary ?? [] });
  if (terms.length === 0) return undefined;
  let text = "";
  for (const t of terms) {
    const next = text === "" ? t : `${text}, ${t}`;
    if (next.length + 1 > maxChars) break;
    text = next;
  }
  return text === "" ? undefined : `${text}.`;
}
