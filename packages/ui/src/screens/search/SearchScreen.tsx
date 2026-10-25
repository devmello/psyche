import type { SearchHit } from "@psyche/protocol";
import type { ReactElement } from "react";
import { Page, PageHeader } from "../../components/page.tsx";
import { t } from "../../i18n/core.ts";
import { useSlots } from "../../slots.tsx";
import { SearchSurface, useMinWidth, useSearchSurface } from "./SearchSurface.tsx";
import { type ParsedSearchQuery, parseSearchQuery } from "./search-query.ts";

export { groupHits, Highlight, highlightTerms, SCOPE_ICON } from "./search-parts.tsx";

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
  onOpenInSideChat?: (hit: SearchHit) => void;
  /** Show the preview column beside the results. */
  preview?: boolean;
  autoFocus?: boolean;
}

/**
 * The Search destination (redesign §5.5): the same surface as ⌘K, embedded full height in the
 * content column for longer sessions. Presentational.
 */
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
  onOpenInSideChat,
  preview = false,
  autoFocus = false,
}: SearchViewProps): ReactElement {
  const results = hits.length;
  const blank = query.trim() === "";
  return (
    <section aria-label={t("screens.search.title")}>
      <Page width={preview ? "full" : "wide"}>
        <PageHeader
          title={t("screens.search.title")}
          meta={
            !blank && !loading && error === null && results > 0
              ? t("screens.search.results", { n: results })
              : undefined
          }
        />
        <SearchSurface
          variant="page"
          query={query}
          onQueryChange={(q) => onQueryChange?.(q)}
          hits={hits}
          parsed={parsed}
          loading={loading}
          loadingDelayMs={loadingDelayMs}
          error={error}
          preview={preview}
          autoFocus={autoFocus}
          {...(onRetry ? { onRetry } : {})}
          {...(onOpen ? { onOpen } : {})}
          {...(onOpenInSideChat ? { onOpenInSideChat } : {})}
        />
      </Page>
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
  /** ⌘↵ on a result: a new side chat about it. */
  onOpenInSideChat?: (hit: SearchHit) => void;
  /** Debounce before querying the Gateway. */
  debounceMs?: number;
  autoFocus?: boolean;
}

/** Connected search: `search.query` with scopes parsed from typed filters. */
export function SearchScreen({
  initialQuery = "",
  onQueryChange,
  onOpen,
  onOpenInSideChat,
  debounceMs = 200,
  autoFocus = false,
}: SearchScreenProps): ReactElement {
  const { navigate } = useSlots();
  const search = useSearchSurface(initialQuery, debounceMs);
  const wide = useMinWidth(1080);
  const open =
    onOpen ??
    ((hit: SearchHit) => {
      if (hit.route != null) navigate?.(hit.route);
    });
  return (
    <SearchView
      query={search.query}
      onQueryChange={(q) => {
        search.setQuery(q);
        onQueryChange?.(q);
      }}
      hits={search.hits}
      parsed={search.parsed}
      loading={search.loading}
      loadingDelayMs={150}
      error={search.error}
      onRetry={search.reload}
      onOpen={open}
      preview={wide}
      autoFocus={autoFocus}
      {...(onOpenInSideChat ? { onOpenInSideChat } : {})}
    />
  );
}
