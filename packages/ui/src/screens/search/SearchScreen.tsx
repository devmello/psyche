import type { SearchHit, SearchScope } from "@psyche/protocol";
import {
  ChevronDown,
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
  Search,
  ShieldQuestion,
  X,
} from "lucide-react";
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  EmptyState,
  ErrorState,
  LoadingCards,
  Page,
  PageHeader,
  SectionLabel,
  useDelayedFlag,
} from "../../components/page.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import { Input } from "../../components/ui/input.tsx";
import { useSearch } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";
import { useSlots } from "../../slots.tsx";
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

// The filter keys (in:, type:, from:) are query syntax, typed as is in every language.
const filterLabel = (f: SearchFilter) =>
  f.key === "in"
    ? t("screens.search.filter", { key: "in", value: SCOPE_LABEL[f.scope] })
    : t("screens.search.filter", { key: f.key, value: f.value });

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

/** `type:` values offered by the Type chip; any other extension can be typed. */
const TYPE_CHOICES: readonly { value: string; label: () => string }[] = [
  { value: "pdf", label: () => t("screens.search.type.pdf") },
  { value: "md", label: () => t("screens.search.type.md") },
  { value: "html", label: () => t("screens.search.type.html") },
  { value: "png", label: () => t("screens.search.type.png") },
];

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
  return parts.map((part, i) =>
    lower.has(part.toLowerCase()) ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: split parts never reorder
      <mark key={i} className="rounded-sm bg-accent-4 px-0.5 text-inherit">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

const chipClass =
  "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-small transition-colors focus-visible:outline-2 focus-visible:outline-ring";

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
  const inputRef = useRef<HTMLInputElement>(null);
  const showSkeleton = useDelayedFlag(loading, loadingDelayMs);
  const groups = groupHits(hits);
  const blank = query.trim() === "";
  const hasFilters = parsed.filters.length > 0 || parsed.unsupported.length > 0;
  const inFilters = parsed.filters.filter(
    (f): f is Extract<SearchFilter, { key: "in" }> => f.key === "in",
  );
  const otherFilters = parsed.filters.filter((f) => f.key !== "in");
  const activeScopes = new Set(inFilters.map((f) => f.scope));
  const terms = highlightTerms(parsed);

  const append = (token: string) => {
    const trimmed = query.trimEnd();
    onQueryChange?.(trimmed === "" ? token : `${trimmed} ${token}`);
  };
  const withoutScopes = (scopes: ReadonlySet<SearchScope>) =>
    inFilters.filter((f) => scopes.has(f.scope)).reduce((q, f) => removeFilter(q, f), query);
  const toggleScope = (scope: SearchScope) => {
    if (activeScopes.has(scope)) onQueryChange?.(withoutScopes(new Set([scope])));
    else append(`in:${scope}`);
  };
  const addFrom = () => {
    append("from:");
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  let body: ReactElement;
  if (blank) {
    body = (
      <EmptyState
        icon={Search}
        action={{
          label: t("screens.search.tryExample", { example: t("screens.search.example") }),
          onClick: () => onQueryChange?.(t("screens.search.example")),
        }}
      >
        {t("screens.search.intro")}
      </EmptyState>
    );
  } else if (parsed.queryText === "" && parsed.types.length === 0) {
    body = <p className="text-small text-gray-11">{t("screens.search.addWord")}</p>;
  } else if (loading) {
    body = showSkeleton ? (
      <LoadingCards label={t("screens.search.searching")} count={3} lines={1} layout="rows" />
    ) : (
      <div aria-busy="true" className="min-h-24" />
    );
  } else if (error !== null) {
    body = (
      <ErrorState
        what={t("screens.search.failed")}
        reason={error}
        did={t("screens.search.indexUnchanged")}
        {...(onRetry ? { retry: { onClick: onRetry } } : {})}
      />
    );
  } else if (groups.length === 0) {
    body = (
      <EmptyState
        icon={Search}
        action={
          hasFilters
            ? {
                label: t("screens.search.withoutFilters"),
                onClick: () => onQueryChange?.(parsed.text),
              }
            : { label: t("screens.search.clear"), onClick: () => onQueryChange?.("") }
        }
      >
        {t("screens.search.nothing", {
          query: parsed.queryText || query.trim(),
          filtered: hasFilters,
        })}
      </EmptyState>
    );
  } else {
    body = (
      <div className="flex flex-col gap-6">
        <p className="sr-only" role="status">
          {t("screens.search.results", { n: hits.length })}
        </p>
        {groups.map((g) => {
          const Icon = SCOPE_ICON[g.scope];
          return (
            <section
              key={g.scope}
              aria-labelledby={`${inputId}-${g.scope}`}
              className="flex flex-col gap-1"
            >
              <SectionLabel id={`${inputId}-${g.scope}`} className="px-2">
                {SCOPE_LABEL[g.scope]} ({g.hits.length})
              </SectionLabel>
              <ul className="flex flex-col">
                {g.hits.map((hit) => (
                  <li key={`${hit.scope}:${hit.id}`}>
                    <button
                      type="button"
                      onClick={() => onOpen?.(hit)}
                      className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-start transition-colors hover:bg-gray-3 focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <span
                        aria-hidden="true"
                        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-gray-3 text-gray-11"
                      >
                        <Icon className="size-4" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-reading font-medium text-foreground">
                          <Highlight text={hit.title} terms={terms} />
                        </span>
                        <span className="sr-only">: </span>
                        <span className="truncate text-small text-gray-11">
                          <Highlight text={hit.snippet} terms={terms} />
                        </span>
                      </span>
                      {hit.scope === "memory" ? (
                        <Badge variant="muted">
                          <ShieldQuestion aria-hidden="true" />
                          {t("screens.search.provenanceUnknown")}
                        </Badge>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    );
  }

  return (
    <section aria-label={t("screens.search.title")}>
      <Page width="wide">
        <PageHeader
          title={t("screens.search.title")}
          meta={
            !blank && !loading && error === null && groups.length > 0
              ? t("screens.search.results", { n: hits.length })
              : undefined
          }
        />
        <div className="flex flex-col gap-3">
          <div className="relative">
            <label htmlFor={inputId} className="sr-only">
              {t("screens.search.label")}
            </label>
            <Search
              className="pointer-events-none absolute top-1/2 start-3.5 size-5 -translate-y-1/2 text-gray-11"
              aria-hidden="true"
            />
            <Input
              ref={inputRef}
              id={inputId}
              type="search"
              value={query}
              placeholder={t("screens.search.placeholder")}
              className="h-12 rounded-lg border-gray-7 bg-gray-2 ps-11 text-reading md:text-reading"
              autoFocus={autoFocus}
              onChange={(e) => onQueryChange?.(e.target.value)}
            />
          </div>

          <div
            role="toolbar"
            aria-label={t("screens.search.filters")}
            className="flex flex-wrap items-center gap-1.5"
          >
            <button
              type="button"
              aria-pressed={activeScopes.size === 0}
              onClick={() => onQueryChange?.(withoutScopes(activeScopes))}
              className={cn(
                chipClass,
                activeScopes.size === 0
                  ? "border-accent-7 bg-accent-3 text-accent-11"
                  : "border-gray-6 text-gray-11 hover:bg-gray-3",
              )}
            >
              {t("screens.search.all")}
            </button>
            {SCOPE_ORDER.map((scope) => {
              const Icon = SCOPE_ICON[scope];
              const on = activeScopes.has(scope);
              return (
                <button
                  key={scope}
                  type="button"
                  aria-pressed={on}
                  aria-label={t("screens.search.filter", { key: "in", value: SCOPE_LABEL[scope] })}
                  onClick={() => toggleScope(scope)}
                  className={cn(
                    chipClass,
                    on
                      ? "border-accent-7 bg-accent-3 text-accent-11"
                      : "border-gray-6 text-gray-11 hover:bg-gray-3",
                  )}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                  {SCOPE_LABEL[scope]}
                </button>
              );
            })}
            <span aria-hidden="true" className="mx-1 h-4 w-px bg-gray-6" />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    className={cn(chipClass, "border-gray-6 text-gray-11 hover:bg-gray-3")}
                  />
                }
              >
                {/* i18n-ignore: query syntax */}
                type:
                <ChevronDown className="size-3.5" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44">
                {TYPE_CHOICES.map((choice) => (
                  <DropdownMenuItem
                    key={choice.value}
                    onClick={() => append(`type:${choice.value}`)}
                  >
                    {choice.label()}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              onClick={addFrom}
              className={cn(chipClass, "border-gray-6 text-gray-11 hover:bg-gray-3")}
            >
              {/* i18n-ignore: query syntax */}
              from:
            </button>
          </div>

          {otherFilters.length > 0 || parsed.unsupported.length > 0 ? (
            <ul
              aria-label={t("screens.search.activeFilters")}
              className="flex flex-wrap items-center gap-1.5"
            >
              {otherFilters.map((f) => (
                <li key={`${f.key}:${f.value}`}>
                  <span className="inline-flex h-6 items-center gap-1 rounded-full bg-accent-3 pe-1 ps-2.5 text-callout text-accent-11">
                    {filterLabel(f)}
                    <button
                      type="button"
                      aria-label={t("screens.search.removeFilter", { filter: filterLabel(f) })}
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
                  <span className="inline-flex h-6 items-center rounded-full border border-dashed border-gray-7 px-2.5 text-callout text-gray-11">
                    {t("screens.search.unknownFilter", { filter: u })}
                  </span>
                </li>
              ))}
              {parsed.from.length > 0 ? (
                <li className="text-callout text-gray-11">{t("screens.search.fromNote")}</li>
              ) : null}
            </ul>
          ) : null}
        </div>
        {body}
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
