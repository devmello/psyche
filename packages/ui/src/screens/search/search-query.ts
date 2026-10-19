import type { SearchHit, SearchScope } from "@psyche/protocol";

/**
 * Typed search filters parsed from the query (UI design §3.13), e.g.
 * `in:feed type:pdf from:alice dentist`.
 *
 * - `in:<scope>` limits the scopes sent to `search.query` (aliases: thread/chat → threads,
 *   message → messages, task/activity → tasks, files → library, …). Repeatable.
 * - `type:<ext>` keeps hits whose title ends in that extension; without `in:` it searches the
 *   Library. Filtered client-side: `search.query` has no type parameter.
 * - `from:<name>` searches messages and threads for that name. `search.query` has no sender
 *   parameter, so the name is added to the text query.
 * - Values may be quoted: `from:"Jane Ortiz"`. Unknown keys and unknown scopes stay in
 *   `unsupported` so the UI can say so instead of silently dropping them.
 */

export type SearchFilter =
  | { key: "in"; value: string; scope: SearchScope }
  | { key: "type"; value: string }
  | { key: "from"; value: string };

export interface ParsedSearchQuery {
  /** Free text, without the filters. */
  text: string;
  filters: SearchFilter[];
  /** Scopes for `search.query`, or undefined for all. */
  scopes: SearchScope[] | undefined;
  /** File extensions, lower-case, without the dot. */
  types: string[];
  from: string[];
  /** Filters Psyche does not understand, as typed (e.g. `in:ideas`, `foo:bar`). */
  unsupported: string[];
  /** The query to send: free text plus `from:` names. */
  queryText: string;
}

const SCOPE_ALIASES: Record<string, SearchScope> = {
  thread: "threads",
  threads: "threads",
  chat: "threads",
  chats: "threads",
  message: "messages",
  messages: "messages",
  task: "tasks",
  tasks: "tasks",
  activity: "tasks",
  memory: "memory",
  library: "library",
  files: "library",
  file: "library",
  documents: "library",
  feed: "feed",
};

const TOKEN = /([a-z]+):("([^"]*)"|\S+)|"([^"]*)"|(\S+)/gi;

export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const words: string[] = [];
  const filters: SearchFilter[] = [];
  const unsupported: string[] = [];
  for (const m of raw.matchAll(TOKEN)) {
    const [whole, rawKey, rawValue, quoted, phrase, word] = m;
    if (rawKey !== undefined && rawValue !== undefined) {
      const key = rawKey.toLowerCase();
      const value = (quoted ?? rawValue).trim();
      if (value === "") {
        unsupported.push(whole);
        continue;
      }
      if (key === "in") {
        const scope = SCOPE_ALIASES[value.toLowerCase()];
        if (scope === undefined) unsupported.push(whole);
        else filters.push({ key: "in", value, scope });
      } else if (key === "type") {
        filters.push({ key: "type", value: value.toLowerCase().replace(/^\./, "") });
      } else if (key === "from") {
        filters.push({ key: "from", value });
      } else if (/^https?$/.test(key)) {
        words.push(whole);
      } else {
        unsupported.push(whole);
      }
      continue;
    }
    const w = phrase ?? word;
    if (w !== undefined && w !== "") words.push(phrase !== undefined ? `"${phrase}"` : w);
  }

  const inScopes = [
    ...new Set(filters.flatMap((f) => (f.key === "in" ? [f.scope] : []))),
  ] as SearchScope[];
  const types = filters.flatMap((f) => (f.key === "type" ? [f.value] : []));
  const from = filters.flatMap((f) => (f.key === "from" ? [f.value] : []));

  let scopes: SearchScope[] | undefined;
  if (inScopes.length > 0) scopes = inScopes;
  else {
    const implied = new Set<SearchScope>();
    if (types.length > 0) implied.add("library");
    if (from.length > 0) {
      implied.add("messages");
      implied.add("threads");
    }
    scopes = implied.size > 0 ? [...implied] : undefined;
  }

  const text = words.join(" ");
  const queryText = [text, ...from].filter((s) => s !== "").join(" ");
  return { text, filters, scopes, types, from, unsupported, queryText };
}

/** Removes one filter token from the raw query (for the filter chips' remove buttons). */
export function removeFilter(raw: string, filter: SearchFilter): string {
  const tokens = [...raw.matchAll(TOKEN)].map((m) => m[0]);
  let removed = false;
  const kept = tokens.filter((t) => {
    if (removed) return true;
    const m = /^([a-z]+):"?([^"]*)"?$/i.exec(t);
    if (
      m?.[1]?.toLowerCase() === filter.key &&
      m[2]?.toLowerCase().replace(/^\./, "") === filter.value.toLowerCase()
    ) {
      removed = true;
      return false;
    }
    return true;
  });
  return kept.join(" ");
}

/** Applies the client-side part of the filters (`type:`) to hits. */
export function filterHits(hits: readonly SearchHit[], parsed: ParsedSearchQuery): SearchHit[] {
  if (parsed.types.length === 0) return [...hits];
  return hits.filter((h) => parsed.types.some((t) => h.title.toLowerCase().endsWith(`.${t}`)));
}

export const SCOPE_ORDER: readonly SearchScope[] = [
  "threads",
  "messages",
  "tasks",
  "memory",
  "library",
  "feed",
];

export const SCOPE_LABEL: Record<SearchScope, string> = {
  threads: "Threads",
  messages: "Messages",
  tasks: "Tasks",
  memory: "Memory",
  library: "Library",
  feed: "Feed",
};
