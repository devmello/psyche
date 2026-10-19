import type { SearchHit, SearchScope } from "@psyche/protocol";
import { Search, ShieldQuestion, X } from "lucide-react";
import { type ReactElement, useEffect, useId, useMemo, useState } from "react";
import { Input } from "../../components/ui/input.tsx";
import { useSearch } from "../../data/hooks.ts";
import { useSlots } from "../../slots.tsx";
import { EmptyState, ErrorState, LoadingCards, useDelayedFlag } from "../feed/states.tsx";
import {
  filterHits,
  type ParsedSearchQuery,
  parseSearchQuery,
  removeFilter,
  SCOPE_LABEL,
  SCOPE_ORDER,
  type SearchFilter,
} from "./search-query.ts";

export function groupHits(hits: readonly SearchHit[]): { scope: SearchScope; hits: SearchHit[] }[] {
  return SCOPE_ORDER.map((scope) => ({
    scope,
    hits: hits.filter((h) => h.scope === scope).sort((a, b) => b.score - a.score),
  })).filter((g) => g.hits.length > 0);
}

const filterLabel = (f: SearchFilter) =>
  f.key === "in" ? `in: ${SCOPE_LABEL[f.scope]}` : `${f.key}: ${f.value}`;

export interface SearchViewProps {
  query: string;
  onQueryChange?: (query: string) => void;
  /** Hits after client-side filters. */
  hits: readonly SearchHit[];
  parsed?: ParsedSearchQuery;
  loading?: boolean;
  loadingDelayMs?: number;
  error?: string | null;
  onRetry?: () => void;
  onOpen?: (hit: SearchHit) => void;
  autoFocus?: boolean;
}

/** Unified search (UI design §3.13). Presentational. */
export function SearchView({
  query,
  onQueryChange,
  hits,
  parsed = parseSearchQuery(query),
  loading = false,
  loadingDelayMs = 0,
  error = null,
  onRetry,
  onOpen,
  autoFocus = false,
}: SearchViewProps): ReactElement {
  const inputId = useId();
  const showSkeleton = useDelayedFlag(loading, loadingDelayMs);
  const groups = groupHits(hits);
  const blank = query.trim() === "";
  const hasFilters = parsed.filters.length > 0 || parsed.unsupported.length > 0;

  let body: ReactElement;
  if (blank) {
    body = (
      <EmptyState action={{ label: "Try “dentist”", onClick: () => onQueryChange?.("dentist") }}>
        Search threads, tasks, memory, Library and Feed. Narrow it with in:feed, type:pdf or
        from:name.
      </EmptyState>
    );
  } else if (parsed.queryText === "" && parsed.types.length === 0) {
    body = <p className="text-sm text-muted-foreground">Add a word to search for.</p>;
  } else if (loading) {
    body = showSkeleton ? (
      <LoadingCards label="Searching" count={3} lines={1} layout="rows" />
    ) : (
      <div aria-busy="true" className="min-h-24" />
    );
  } else if (error !== null) {
    body = (
      <ErrorState
        what="Search failed"
        reason={error}
        did="The index is unchanged."
        {...(onRetry ? { retry: { onClick: onRetry } } : {})}
      />
    );
  } else if (groups.length === 0) {
    body = (
      <EmptyState
        action={
          hasFilters
            ? {
                label: "Search without filters",
                onClick: () => onQueryChange?.(parsed.text),
              }
            : { label: "Clear search", onClick: () => onQueryChange?.("") }
        }
      >
        Nothing matches “{parsed.queryText || query.trim()}”
        {hasFilters ? " with these filters" : ""}.
      </EmptyState>
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        <p className="sr-only" role="status">
          {hits.length} results
        </p>
        {groups.map((g) => (
          <section key={g.scope} aria-labelledby={`${inputId}-${g.scope}`}>
            <h2
              id={`${inputId}-${g.scope}`}
              className="text-label font-semibold text-muted-foreground uppercase"
            >
              {SCOPE_LABEL[g.scope]} ({g.hits.length})
            </h2>
            <ul className="mt-1 flex flex-col">
              {g.hits.map((hit) => (
                <li key={`${hit.scope}:${hit.id}`}>
                  <button
                    type="button"
                    onClick={() => onOpen?.(hit)}
                    className="flex w-full flex-wrap items-baseline gap-x-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-gray-3 focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span className="font-medium">{hit.title}</span>
                    <span className="sr-only">: </span>
                    <span className="min-w-0 flex-1 truncate text-gray-11">{hit.snippet}</span>
                    {hit.scope === "memory" ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-gray-6 px-1.5 text-xs text-muted-foreground">
                        <ShieldQuestion className="size-3" aria-hidden="true" />
                        provenance unknown
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  }

  return (
    <section aria-label="Search" className="mx-auto flex max-w-[80ch] flex-col gap-4 p-4">
      <h1 className="sr-only">Search</h1>
      <div className="relative">
        <label htmlFor={inputId} className="sr-only">
          Search everything
        </label>
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id={inputId}
          type="search"
          value={query}
          placeholder="Search, or filter with in:feed type:pdf from:alice"
          className="h-10 pl-8 text-base"
          autoFocus={autoFocus}
          onChange={(e) => onQueryChange?.(e.target.value)}
        />
      </div>
      {hasFilters ? (
        <ul aria-label="Filters" className="flex flex-wrap gap-1.5">
          {parsed.filters.map((f) => (
            <li key={`${f.key}:${f.value}`}>
              <span className="inline-flex items-center gap-1 rounded-full bg-accent-3 py-0.5 pr-1 pl-2 text-xs text-accent-11">
                {filterLabel(f)}
                <button
                  type="button"
                  aria-label={`Remove filter ${filterLabel(f)}`}
                  onClick={() => onQueryChange?.(removeFilter(query, f))}
                  className="rounded-full p-0.5 hover:bg-accent-5 focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
          {parsed.unsupported.map((u) => (
            <li key={u}>
              <span className="inline-flex items-center rounded-full border border-dashed border-gray-7 px-2 py-0.5 text-xs text-muted-foreground">
                {u} (not a filter Psyche knows; ignored)
              </span>
            </li>
          ))}
          {parsed.from.length > 0 ? (
            <li className="text-xs text-muted-foreground">
              from: matches the name in text; sender filtering isn't available yet.
            </li>
          ) : null}
        </ul>
      ) : null}
      {body}
    </section>
  );
}

export interface SearchScreenProps {
  /** From `/search?q=`. */
  initialQuery?: string;
  /** Lets the shell keep `?q=` in sync. */
  onQueryChange?: (query: string) => void;
  /** Defaults to `navigate(hit.route)`. */
  onOpen?: (hit: SearchHit) => void;
  /** Debounce before querying the Gateway. */
  debounceMs?: number;
  autoFocus?: boolean;
}

/** Connected search: `search.query` with scopes parsed from typed filters. */
export function SearchScreen({
  initialQuery = "",
  onQueryChange,
  onOpen,
  debounceMs = 200,
  autoFocus = false,
}: SearchScreenProps): ReactElement {
  const { navigate } = useSlots();
  const [query, setQuery] = useState(initialQuery);
  const [settled, setSettled] = useState(initialQuery);
  useEffect(() => {
    if (debounceMs === 0) {
      setSettled(query);
      return;
    }
    const t = setTimeout(() => setSettled(query), debounceMs);
    return () => clearTimeout(t);
  }, [query, debounceMs]);

  const parsed = useMemo(() => parseSearchQuery(settled), [settled]);
  const search = useSearch(
    parsed.queryText === "" ? parsed.types.join(" ") : parsed.queryText,
    parsed.scopes,
  );
  const hits = useMemo(() => filterHits(search.hits, parsed), [search.hits, parsed]);

  const open =
    onOpen ??
    ((hit: SearchHit) => {
      if (hit.route != null) navigate?.(hit.route);
    });

  return (
    <SearchView
      query={query}
      onQueryChange={(q) => {
        setQuery(q);
        onQueryChange?.(q);
      }}
      hits={hits}
      parsed={parseSearchQuery(query)}
      loading={search.loading || query !== settled}
      loadingDelayMs={150}
      error={search.error}
      onRetry={search.reload}
      onOpen={open}
      autoFocus={autoFocus}
    />
  );
}
