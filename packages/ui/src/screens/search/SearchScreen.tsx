import type { EntitySummary, SearchHit, SearchIndexStatus } from "@psyche/protocol";
import { RefreshCw } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Page, PageHeader } from "../../components/page.tsx";
import { Button } from "../../components/ui/button.tsx";
import { useSearchIndexStatus } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { ConnectedEntityCard } from "../../people/ConnectedEntityCard.tsx";
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
  /** People and projects for the query, shown first (docs/memory/people-and-projects-2026.md §6.4). */
  entities?: readonly EntitySummary[];
  onOpenEntity?: (entity: EntitySummary) => void;
  renderEntityPreview?: (entity: EntitySummary) => ReactNode;
  now?: number;
  /** Backfill progress (`search.status`); a running backfill shows a status line. */
  indexStatus?: SearchIndexStatus;
  /** Rebuilds the index; offered when a search finds nothing or fails. */
  onReindex?: () => void;
  reindexing?: boolean;
}

/** "Indexing your history…" while the backfill runs; "Rebuild search index" when nothing is found. */
function IndexStatusLine({
  status,
  offerRebuild,
  onReindex,
  reindexing = false,
}: {
  status: SearchIndexStatus | undefined;
  offerRebuild: boolean;
  onReindex: (() => void) | undefined;
  reindexing?: boolean;
}): ReactElement | null {
  const backfill = status?.backfill;
  const running = backfill?.state === "running";
  const failed = backfill?.state === "error";
  if (!running && !failed && !(offerRebuild && onReindex)) return null;
  return (
    <div
      role="status"
      className="mt-3 flex flex-wrap items-center gap-3 px-3 text-callout text-label-secondary"
    >
      {running ? (
        <span className="flex items-center gap-2">
          <RefreshCw
            aria-hidden="true"
            className="size-3.5 motion-safe:animate-spin"
            strokeWidth={1.75}
          />
          {t("screens.search.indexing", { n: backfill.done })}
        </span>
      ) : null}
      {failed ? (
        <span>{t("screens.search.indexFailed", { reason: backfill.error ?? "" })}</span>
      ) : null}
      {!running && onReindex && (failed || offerRebuild) ? (
        <Button variant="ghost" size="sm" disabled={reindexing} onClick={onReindex}>
          {reindexing ? t("screens.search.rebuilding") : t("screens.search.rebuild")}
        </Button>
      ) : null}
    </div>
  );
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
  entities,
  onOpenEntity,
  renderEntityPreview,
  now,
  indexStatus,
  onReindex,
  reindexing,
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
          {...(entities ? { entities } : {})}
          {...(onOpenEntity ? { onOpenEntity } : {})}
          {...(renderEntityPreview ? { renderEntityPreview } : {})}
          {...(now !== undefined ? { now } : {})}
        />
        <IndexStatusLine
          status={indexStatus}
          offerRebuild={!blank && !loading && (error !== null || results === 0)}
          onReindex={onReindex}
          {...(reindexing === undefined ? {} : { reindexing })}
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
  /** Opens a person or project; defaults to Soul & Memory → People & projects. */
  onOpenEntity?: (entity: EntitySummary) => void;
  /** Fixed clock (stories, tests). */
  now?: number;
}

/** Connected search: `search.query` with scopes parsed from typed filters. */
export function SearchScreen({
  initialQuery = "",
  onQueryChange,
  onOpen,
  onOpenInSideChat,
  debounceMs = 200,
  autoFocus = false,
  onOpenEntity,
  now,
}: SearchScreenProps): ReactElement {
  const { navigate } = useSlots();
  const search = useSearchSurface(initialQuery, debounceMs);
  const index = useSearchIndexStatus();
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
      entities={search.entities}
      onOpenEntity={
        onOpenEntity ?? ((e) => navigate?.(`/agent/soul?entity=${encodeURIComponent(e.id)}`))
      }
      renderEntityPreview={(e) => (
        <ConnectedEntityCard
          id={e.id}
          recentLimit={3}
          className="bg-transparent p-0 shadow-none"
          {...(now !== undefined ? { now } : {})}
        />
      )}
      {...(now !== undefined ? { now } : {})}
      {...(index.status === undefined ? {} : { indexStatus: index.status })}
      onReindex={() => void index.reindex().catch(() => undefined)}
      reindexing={index.reindexing}
    />
  );
}
