import type { MemoryStore, NodeClient } from "@psyche/protocol";

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
  /** Preceding transcript (the last final), appended after the glossary for continuity. */
  context?: string,
): string | undefined {
  const terms = buildVocabulary({ custom: vocabulary ?? [] });
  let text = "";
  for (const t of terms) {
    const next = text === "" ? t : `${text}, ${t}`;
    if (next.length + 1 > maxChars) break;
    text = next;
  }
  if (text !== "") text = `${text}.`;
  const tail = cleanContext(context ?? "");
  if (tail !== "") {
    const room = maxChars - text.length - 1;
    if (room > 0) text = `${text}${text === "" ? "" : " "}${tail.slice(-room).trimStart()}`;
  }
  return text === "" ? undefined : text;
}

/** Context text with control characters, placeholders and markup removed. */
function cleanContext(text: string): string {
  return [...text]
    .map((ch) => {
      const c = ch.charCodeAt(0);
      return c < 0x20 || c === 0x7f ? " " : ch;
    })
    .join("")
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/[<>{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Sources: persona files, contacts, topics ---------------------------------------------------

/**
 * Where contact names come from: the Mac helper's Contacts capability (S14), a connector's
 * people cache, or a test list. Names only; nothing else about a contact belongs in a recognizer.
 */
export interface ContactsSource {
  names(options?: { limit?: number; signal?: AbortSignal }): Promise<string[]>;
}

/** Node capability the helper is asked to add (docs/archive/status/s17.md → S14 issue). */
export const NODE_CONTACTS_CAPABILITY = "contacts.list";

export interface NodeContactsSourceOptions {
  node: () => NodeClient | undefined | Promise<NodeClient | undefined>;
  capability?: string;
  /** Contacts asked for per call (helper caps at 2000). */
  limit?: number;
  timeoutMs?: number;
}

/**
 * Contact names over the node protocol: `contacts.list {limit, fields: ["name"]}` →
 * `{contacts: [{id, name, nickname?, organization?}]}` (read-only capability). A node that is
 * offline or lacks the capability yields no names rather than an error: vocabulary is best effort.
 */
export class NodeContactsSource implements ContactsSource {
  readonly #opts: NodeContactsSourceOptions;

  constructor(options: NodeContactsSourceOptions) {
    this.#opts = options;
  }

  async names(options: { limit?: number; signal?: AbortSignal } = {}): Promise<string[]> {
    const node = await this.#opts.node();
    if (node === undefined) return [];
    const capability = this.#opts.capability ?? NODE_CONTACTS_CAPABILITY;
    if (!(await node.capabilities()).some((c) => c.name === capability)) return [];
    const limit = Math.min(options.limit ?? this.#opts.limit ?? 500, 2000);
    const invoke: { signal?: AbortSignal; timeoutMs: number } = {
      timeoutMs: this.#opts.timeoutMs ?? 10_000,
    };
    if (options.signal !== undefined) invoke.signal = options.signal;
    const res = await node.invoke(capability, { limit, fields: ["name"] }, invoke);
    if (!res.ok) return [];
    const list = (res.result as { contacts?: { name?: unknown; nickname?: unknown }[] } | null)
      ?.contacts;
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    for (const c of list) {
      if (typeof c?.name === "string") out.push(c.name);
      if (typeof c?.nickname === "string") out.push(c.nickname);
    }
    return out;
  }
}

/** The agent's `name:` from IDENTITY.md frontmatter (data model §7.1). */
export function agentNameFrom(identityMd: string | undefined): string | undefined {
  if (identityMd === undefined) return undefined;
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(identityMd);
  if (m === null) return undefined;
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^name\s*:\s*(.+?)\s*$/i.exec(line);
    if (kv !== null) return unquote(kv[1] ?? "");
  }
  return undefined;
}

const PEOPLE_HEADING_RE =
  /^#{1,6}\s*(?:people|contacts?|family|friends|team|colleagues|coworkers|household|names)\b/i;

/**
 * Names from USER.md: the owner's `Name:` field, then the people listed under a heading such as
 * `## People`, `## Family` or `## Contacts` (one bullet each; the name is the text before the
 * first `(`, `,`, `:` or dash). Directives and free text are not mined for names.
 */
export function ownerNamesFrom(userMd: string | undefined): { owner?: string; people: string[] } {
  const people: string[] = [];
  if (userMd === undefined) return { people };
  let owner: string | undefined;
  let inPeople = false;
  for (const raw of userMd.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(line)) {
      inPeople = PEOPLE_HEADING_RE.test(line);
      continue;
    }
    if (owner === undefined) {
      const m = /^(?:[-*]\s*)?(?:\*\*)?name(?:\*\*)?\s*:\s*([^.;,(]+)/i.exec(line);
      if (m !== null) {
        owner = (m[1] ?? "").trim();
        continue;
      }
    }
    if (inPeople) {
      const m = /^[-*]\s+(.+)$/.exec(line);
      if (m === null) continue;
      const name = (m[1] ?? "")
        .replace(/\*\*/g, "")
        .split(/\s*[(,:;—–]\s*|\s+-\s+/)[0]
        ?.trim();
      if (name !== undefined && name !== "" && !/^(?:name|timezone)\b/i.test(name)) {
        people.push(name);
      }
    }
  }
  return owner === undefined ? { people } : { owner, people };
}

function unquote(s: string): string {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
    ? t.slice(1, -1)
    : t;
}

export interface DictationVocabularyOptions {
  /** Workspace reader for IDENTITY.md and USER.md (`MemoryStore.readFile`). */
  memory?: Pick<MemoryStore, "readFile">;
  contacts?: ContactsSource;
  /** Owner-added terms (Settings → Voice & dictation, `speech.stt.vocabulary`). */
  custom?: () => Promise<readonly string[]> | readonly string[];
  /** Recent topics or entity names, newest first. */
  topics?: () => Promise<readonly string[]> | readonly string[];
  /** How long one assembled list is reused (default 60 s). */
  ttlMs?: number;
  max?: number;
  now?: () => number;
  /** Contacts asked for per refresh (overrides the source's own default). */
  contactsLimit?: number;
}

/**
 * The session-default vocabulary for `voice.start` and voice memos (feature Q1/Q4, spike 03):
 * agent name (IDENTITY.md), owner name and the people in USER.md, the owner's custom terms,
 * contact names, recent topics, in `buildVocabulary`'s priority order and limits. The list is
 * always non-empty when IDENTITY.md has a name, which is what makes the Mac helper pick
 * `DictationTranscriber` with `contextualStrings` (3.0–3.4 % WER against 6.5 % without, 4/4 on
 * the agent name) instead of `SpeechTranscriber`. Sources that fail are skipped, never fatal.
 */
export class DictationVocabularyProvider {
  readonly #opts: DictationVocabularyOptions;
  #cache: { at: number; terms: string[] } | undefined;
  #inflight: Promise<string[]> | undefined;

  constructor(options: DictationVocabularyOptions = {}) {
    this.#opts = options;
  }

  /** The current list; cached for `ttlMs`, concurrent callers share one refresh. */
  get(): Promise<string[]> {
    const now = this.#opts.now?.() ?? Date.now();
    if (this.#cache !== undefined && now - this.#cache.at < (this.#opts.ttlMs ?? 60_000)) {
      return Promise.resolve([...this.#cache.terms]);
    }
    this.#inflight ??= this.refresh().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  /** Drops the cache (persona or USER.md changed, a contact synced). */
  invalidate(): void {
    this.#cache = undefined;
  }

  /** Rebuilds the list now. */
  async refresh(): Promise<string[]> {
    const sources = await this.sources();
    const terms = buildVocabulary(sources, this.#opts.max ?? VOCABULARY_MAX_TERMS);
    this.#cache = { at: this.#opts.now?.() ?? Date.now(), terms };
    return [...terms];
  }

  /** Each source as read (Settings "why these words", tests). */
  async sources(): Promise<VocabularySources> {
    const out: VocabularySources & { contacts?: string[] } = {};
    const [identity, user] = await Promise.all([this.#read("IDENTITY.md"), this.#read("USER.md")]);
    const agentName = agentNameFrom(identity);
    if (agentName !== undefined) out.agentName = agentName;
    const names = ownerNamesFrom(user);
    if (names.owner !== undefined) out.ownerName = names.owner;
    const custom = await this.#call(this.#opts.custom);
    if (custom.length > 0) out.custom = custom;
    const fromSource =
      this.#opts.contacts === undefined
        ? []
        : await this.#opts.contacts
            .names(
              this.#opts.contactsLimit === undefined ? {} : { limit: this.#opts.contactsLimit },
            )
            .catch((): string[] => []);
    const contacts = [...names.people, ...fromSource];
    if (contacts.length > 0) out.contacts = contacts;
    const topics = await this.#call(this.#opts.topics);
    if (topics.length > 0) out.topics = topics;
    return out;
  }

  async #read(path: string): Promise<string | undefined> {
    try {
      return (await this.#opts.memory?.readFile(path))?.content;
    } catch {
      return undefined;
    }
  }

  async #call(
    fn: (() => Promise<readonly string[]> | readonly string[]) | undefined,
  ): Promise<string[]> {
    if (fn === undefined) return [];
    try {
      return [...(await fn())];
    } catch {
      return [];
    }
  }
}
