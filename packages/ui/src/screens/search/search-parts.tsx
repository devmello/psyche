import type { SearchHit, SearchScope } from "@psyche/protocol";
import {
  CircleCheck,
  Fingerprint,
  Library as LibraryIcon,
  Lightbulb,
  ListChecks,
  type LucideIcon,
  MessageCircle,
  MessagesSquare,
  Newspaper,
  Plug,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { type ParsedSearchQuery, SCOPE_ORDER } from "./search-query.ts";

/** Pieces shared by the search surface, the Search page and the palette (redesign §5.5). */

export function groupHits(hits: readonly SearchHit[]): { scope: SearchScope; hits: SearchHit[] }[] {
  return SCOPE_ORDER.map((scope) => ({
    scope,
    hits: hits.filter((h) => h.scope === scope).sort((a, b) => b.score - a.score),
  })).filter((g) => g.hits.length > 0);
}

/** Lucide icons per result kind (§4.6). */
export const SCOPE_ICON: Record<SearchScope, LucideIcon> = {
  threads: MessageCircle,
  messages: MessagesSquare,
  tasks: ListChecks,
  memory: Fingerprint,
  library: LibraryIcon,
  feed: Newspaper,
  ideas: Lightbulb,
  goals: CircleCheck,
  connectors: Plug,
};

/** The words to highlight: free text (quotes stripped) and `from:` names. */
export function highlightTerms(parsed: ParsedSearchQuery): string[] {
  const words = [...parsed.text.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? "");
  return [...new Set([...words, ...parsed.from].map((w) => w.trim()).filter((w) => w.length > 1))];
}

/** Wraps each case-insensitive match of `terms` in `<mark>`. */
export function Highlight({ text, terms }: { text: string; terms: readonly string[] }): ReactNode {
  if (terms.length === 0) return text;
  const escaped = [...terms]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = text.split(new RegExp(`(${escaped.join("|")})`, "gi"));
  const lower = new Set(terms.map((w) => w.toLowerCase()));
  // Each part keyed by where it starts in the text: stable for a given text and terms.
  let start = 0;
  return parts.map((part) => {
    const at = start;
    start += part.length;
    return lower.has(part.toLowerCase()) ? (
      <mark key={`m${at}`} className="rounded-xs bg-accent-a4 px-0.5 text-inherit">
        {part}
      </mark>
    ) : (
      <Fragment key={`t${at}`}>{part}</Fragment>
    );
  });
}
