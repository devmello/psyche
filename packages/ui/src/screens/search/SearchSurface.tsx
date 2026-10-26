import type { SearchHit, SearchScope } from "@psyche/protocol";
import { ChevronDown, CornerDownLeft, Search, ShieldQuestion, X, Zap } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { EmptyState, ErrorState, LoadingCards, useDelayedFlag } from "../../components/page.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import { Kbd } from "../../components/ui/kbd.tsx";
import { useSearch } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";
import { entityDetail } from "../../people/EntityRow.tsx";
import { EntityMonogram } from "../../people/glyphs.tsx";
import type { EntitySummary } from "../../people/types.ts";
import type { PaletteAction } from "../../shell/CommandPalette.tsx";
import { isMac } from "../../shell/shortcuts.ts";
import { Highlight, highlightTerms, SCOPE_ICON } from "./search-parts.tsx";
import {
  filterHits,
  type ParsedSearchQuery,
  parseSearchQuery,
  removeFilter,
  SCOPE_LABEL,
  SCOPE_ORDER,
  type SearchFilter,
} from "./search-query.ts";

/**
 * One search surface for ⌘K and the Search destination (redesign §5.5): a field with the typed
 * filters (`in:`, `type:`, `from:`) as chips inline, results grouped by kind as one listbox the
 * keyboard walks (↑ ↓, ↵ open, ⌘↵ open in a side chat, Tab to the filters), and a preview of the
 * selected result when there is room. The palette adds an Actions group; results update without
 * animation per keystroke (motion.md §4.2).
 */

/** A row of the surface: an action (palette only) or a search hit. */
export type SurfaceItem =
  | { kind: "action"; key: string; action: PaletteAction }
  | { kind: "hit"; key: string; hit: SearchHit }
  | { kind: "entity"; key: string; entity: EntitySummary };

export interface SurfaceGroup {
  id: SearchScope | "actions" | "people" | "projects";
  label: string;
  items: SurfaceItem[];
}

/**
 * People and Projects first (docs/memory/people-and-projects-2026.md §6.4), then hits by kind in
 * the index's order, best first; matching actions last (§5.5).
 */
export function surfaceGroups(
  hits: readonly SearchHit[],
  actions: readonly PaletteAction[],
  text: string,
  entities: readonly EntitySummary[] = [],
): SurfaceGroup[] {
  const entityGroup = (id: "people" | "projects", label: string, rows: EntitySummary[]) => ({
    id,
    label,
    items: rows.map(
      (entity): SurfaceItem => ({ kind: "entity", key: `entity:${entity.id}`, entity }),
    ),
  });
  const people = entityGroup(
    "people",
    t("people.group.people"),
    entities.filter((e) => e.kind !== "project"),
  );
  const projects = entityGroup(
    "projects",
    t("people.group.projects"),
    entities.filter((e) => e.kind === "project"),
  );
  const groups: SurfaceGroup[] = [people, projects].filter((g) => g.items.length > 0);
  const scoped: SurfaceGroup[] = SCOPE_ORDER.map((scope) => ({
    id: scope,
    label: SCOPE_LABEL[scope],
    items: hits
      .filter((h) => h.scope === scope)
      .sort((a, b) => b.score - a.score)
      .map((hit): SurfaceItem => ({ kind: "hit", key: `${hit.scope}:${hit.id}`, hit })),
  })).filter((g) => g.items.length > 0);
  groups.push(...scoped);
  const needle = text.trim().toLowerCase();
  const matching = actions.filter((a) => needle === "" || a.label.toLowerCase().includes(needle));
  if (matching.length > 0)
    groups.push({
      id: "actions",
      label: t("shell.palette.actions"),
      items: matching.map((action) => ({ kind: "action", key: `action:${action.id}`, action })),
    });
  return groups;
}

/** `type:` values offered by the Type chip; any other extension can be typed. */
const TYPE_CHOICES: readonly { value: string; label: () => string }[] = [
  { value: "pdf", label: () => t("screens.search.type.pdf") },
  { value: "md", label: () => t("screens.search.type.md") },
  { value: "html", label: () => t("screens.search.type.html") },
  { value: "png", label: () => t("screens.search.type.png") },
];

// The filter keys (in:, type:, from:) are query syntax, typed as is in every language.
const filterLabel = (f: SearchFilter) =>
  f.key === "in"
    ? t("screens.search.filter", { key: "in", value: SCOPE_LABEL[f.scope] })
    : t("screens.search.filter", { key: f.key, value: f.value });

const chipClass =
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-callout outline-none transition-colors duration-(--duration-micro) focus-visible:ring-2 focus-visible:ring-ring";

export interface SearchSurfaceProps {
  variant: "palette" | "page";
  query: string;
  onQueryChange: (query: string) => void;
  /** Hits after client-side filters. */
  hits: readonly SearchHit[];
  parsed?: ParsedSearchQuery;
  loading?: boolean;
  loadingDelayMs?: number;
  error?: string | null;
  onRetry?: () => void;
  /** The palette's commands (Go to …, open a pane, /model …). */
  actions?: readonly PaletteAction[];
  onOpen?: (hit: SearchHit) => void;
  /** ⌘↵: open the hit in a new side chat. */
  onOpenInSideChat?: (hit: SearchHit) => void;
  onRunAction?: (action: PaletteAction) => void;
  /** Show the preview column (the host decides by width: ≥ 1080 px). */
  preview?: boolean;
  autoFocus?: boolean;
  /** People and projects matching the query (`memory.entities.search`), shown first. */
  entities?: readonly EntitySummary[];
  onOpenEntity?: (entity: EntitySummary) => void;
  /** The card for the selected person or project in the preview column. */
  renderEntityPreview?: (entity: EntitySummary) => ReactNode;
  /** The clock for "last talked …" lines. */
  now?: number;
}

export function SearchSurface({
  variant,
  query,
  onQueryChange,
  hits,
  parsed = parseSearchQuery(query),
  loading = false,
  loadingDelayMs = 0,
  error = null,
  onRetry,
  actions = [],
  onOpen,
  onOpenInSideChat,
  onRunAction,
  preview = false,
  autoFocus = false,
  entities = [],
  onOpenEntity,
  renderEntityPreview,
  now = Date.now(),
}: SearchSurfaceProps): ReactElement {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const showSkeleton = useDelayedFlag(loading, loadingDelayMs);
  const blank = query.trim() === "";
  const palette = variant === "palette";
  const searching = !blank && !(parsed.queryText === "" && parsed.types.length === 0);
  const groups = useMemo(
    () =>
      surfaceGroups(
        searching ? hits : [],
        palette ? actions : [],
        parsed.text,
        searching ? entities : [],
      ),
    [searching, hits, palette, actions, parsed.text, entities],
  );
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  // Each keystroke (or a new result set) puts the selection back on the best result: the index
  // only counts for the query and results it was chosen in.
  const resetKey = `${query}\u0000${flat.length}`;
  const [selection, setSelection] = useState({ key: resetKey, index: 0 });
  const active = selection.key === resetKey ? selection.index : 0;
  const setActive = (next: number | ((index: number) => number)) =>
    setSelection((s) => {
      const from = s.key === resetKey ? s.index : 0;
      return { key: resetKey, index: typeof next === "function" ? next(from) : next };
    });
  const current = flat[Math.min(active, flat.length - 1)];
  const optionId = (key: string) => `${baseId}-opt-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  useEffect(() => {
    if (!current) return;
    const el = document.getElementById(optionId(current.key));
    el?.scrollIntoView?.({ block: "nearest" });
  });

  const terms = highlightTerms(parsed);
  const inFilters = parsed.filters.filter(
    (f): f is Extract<SearchFilter, { key: "in" }> => f.key === "in",
  );
  const activeScopes = new Set(inFilters.map((f) => f.scope));
  const withoutScopes = (scopes: ReadonlySet<SearchScope>) =>
    inFilters.filter((f) => scopes.has(f.scope)).reduce((q, f) => removeFilter(q, f), query);
  const append = (token: string) => {
    const trimmed = query.trimEnd();
    onQueryChange(trimmed === "" ? token : `${trimmed} ${token}`);
  };
  const toggleScope = (scope: SearchScope) => {
    if (activeScopes.has(scope)) onQueryChange(withoutScopes(new Set([scope])));
    else append(`in:${scope}`);
  };
  const focusField = () => requestAnimationFrame(() => inputRef.current?.focus());

  const choose = (item: SurfaceItem | undefined, sideChat = false) => {
    if (!item) return;
    if (item.kind === "action") onRunAction?.(item.action);
    else if (item.kind === "entity") onOpenEntity?.(item.entity);
    else if (sideChat && onOpenInSideChat) onOpenInSideChat(item.hit);
    else onOpen?.(item.hit);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length === 0) return;
      setActive((i) =>
        e.key === "ArrowDown" ? Math.min(flat.length - 1, i + 1) : Math.max(0, i - 1),
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const mod = isMac() ? e.metaKey : e.ctrlKey;
      choose(current, mod);
    } else if (e.key === "Escape" && !palette && query !== "") {
      e.preventDefault();
      onQueryChange("");
    }
  };

  // Chips for the filters typed in the field, removable in place (§5.5).
  const chips = [...parsed.filters, ...parsed.unsupported.map((u) => ({ key: "?", value: u }))];

  let results: ReactNode;
  if (!searching && !palette) {
    results = blank ? (
      <EmptyState
        icon={Search}
        action={{
          label: t("screens.search.tryExample", { example: t("screens.search.example") }),
          onClick: () => onQueryChange(t("screens.search.example")),
        }}
      >
        {t("screens.search.intro")}
      </EmptyState>
    ) : (
      <p className="px-3 text-callout text-label-secondary">{t("screens.search.addWord")}</p>
    );
  } else if (searching && loading && flat.length === 0) {
    results = showSkeleton ? (
      <LoadingCards label={t("screens.search.searching")} count={3} lines={1} layout="rows" />
    ) : (
      <div aria-busy="true" className="min-h-24" />
    );
  } else if (searching && error !== null && flat.length === 0) {
    results = (
      <ErrorState
        what={t("screens.search.failed")}
        reason={error}
        did={t("screens.search.indexUnchanged")}
        {...(onRetry ? { retry: { onClick: onRetry } } : {})}
      />
    );
  } else if (flat.length === 0) {
    const filtered = parsed.filters.length > 0 || parsed.unsupported.length > 0;
    results = palette ? (
      <p className="px-3 py-6 text-center text-callout text-label-secondary" role="status">
        {t("shell.palette.nothing")}
      </p>
    ) : (
      <EmptyState
        icon={Search}
        action={
          filtered
            ? {
                label: t("screens.search.withoutFilters"),
                onClick: () => onQueryChange(parsed.text),
              }
            : { label: t("screens.search.clear"), onClick: () => onQueryChange("") }
        }
      >
        {t("screens.search.nothing", { query: parsed.queryText || query.trim(), filtered })}
      </EmptyState>
    );
  } else {
    results = (
      <>
        <p className="sr-only" role="status">
          {t("screens.search.results", { n: flat.filter((i) => i.kind !== "action").length })}
        </p>
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={t("shell.search.results")}
          className="flex flex-col gap-3"
        >
          {groups.map((g) => (
            // biome-ignore lint/a11y/useSemanticElements: an option group inside a listbox has no native element
            <div
              key={g.id}
              role="group"
              aria-label={t("shell.palette.group", { scope: g.label, n: g.items.length })}
              className="flex flex-col"
            >
              <div aria-hidden="true" className="px-3 pb-1 text-caption text-label-tertiary">
                {g.label}
              </div>
              {g.items.map((item) => {
                const index = flat.indexOf(item);
                const selected = item === current;
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: the field handles the keyboard
                  <div
                    key={item.key}
                    id={optionId(item.key)}
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    onMouseMove={() => index !== active && setActive(index)}
                    onClick={(e) => choose(item, isMac() ? e.metaKey : e.ctrlKey)}
                    className={cn(
                      "flex min-h-9 items-center gap-3 rounded-md px-3 py-1.5 text-start",
                      selected ? "bg-selection" : "",
                    )}
                    data-testid="search-option"
                  >
                    <SurfaceRow item={item} terms={terms} now={now} />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </>
    );
  }

  return (
    <div
      className={cn("flex min-h-0 flex-col", palette ? "max-h-[min(560px,70vh)]" : "gap-3")}
      data-testid={palette ? "search-palette" : "search-page"}
      data-variant={variant}
    >
      <div
        className={cn(
          "flex min-h-11 flex-wrap items-center gap-1.5 px-3",
          palette
            ? "border-b border-separator py-1.5"
            : "rounded-lg bg-fill-quaternary py-1.5 shadow-[inset_0_0_0_0.5px_var(--separator)]",
        )}
      >
        <Search className="size-4 shrink-0 text-label-secondary" aria-hidden="true" />
        {chips.length > 0 ? (
          <ul aria-label={t("screens.search.activeFilters")} className="contents">
            {chips.map((f) => {
              const known = f.key !== "?";
              const label = known
                ? filterLabel(f as SearchFilter)
                : t("screens.search.unknownFilter", { filter: f.value });
              return (
                <li key={`${f.key}:${f.value}`}>
                  <span
                    className={cn(
                      chipClass,
                      "pe-1",
                      known
                        ? "bg-accent-a3 text-accent-11"
                        : "border border-dashed border-separator-strong text-label-secondary",
                    )}
                  >
                    {label}
                    <button
                      type="button"
                      aria-label={t("screens.search.removeFilter", { filter: label })}
                      onClick={() => {
                        onQueryChange(
                          known
                            ? removeFilter(query, f as SearchFilter)
                            : query.replace(f.value, "").replace(/\s+/g, " ").trim(),
                        );
                        focusField();
                      }}
                      className="rounded-full p-0.5 outline-none hover:bg-fill-tertiary focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X className="size-3" aria-hidden="true" />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
        <label htmlFor={`${baseId}-field`} className="sr-only">
          {palette ? t("shell.palette.placeholder") : t("screens.search.label")}
        </label>
        <input
          ref={inputRef}
          id={`${baseId}-field`}
          type="text"
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          {...(current ? { "aria-activedescendant": optionId(current.key) } : {})}
          value={query}
          placeholder={palette ? t("shell.palette.placeholder") : t("screens.search.placeholder")}
          // biome-ignore lint/a11y/noAutofocus: the surface opens to type into it
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          className={cn(
            "h-8 min-w-32 flex-1 bg-transparent text-label-primary outline-none placeholder:text-label-tertiary",
            palette ? "text-title-3 font-normal" : "text-reading",
          )}
        />
      </div>

      <div
        role="toolbar"
        aria-label={t("screens.search.filters")}
        className={cn(
          "flex flex-wrap items-center gap-1",
          palette && "border-b border-separator px-3 py-1.5",
        )}
      >
        <button
          type="button"
          aria-pressed={activeScopes.size === 0}
          onClick={() => onQueryChange(withoutScopes(activeScopes))}
          className={cn(
            chipClass,
            activeScopes.size === 0
              ? "bg-accent-a3 text-accent-11"
              : "text-label-secondary hover:bg-fill-quaternary",
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
                  ? "bg-accent-a3 text-accent-11"
                  : "text-label-secondary hover:bg-fill-quaternary",
              )}
            >
              <Icon className="size-3.5" aria-hidden="true" strokeWidth={1.75} />
              {SCOPE_LABEL[scope]}
            </button>
          );
        })}
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-separator" />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className={cn(chipClass, "text-label-secondary hover:bg-fill-quaternary")}
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
                onClick={() => {
                  append(`type:${choice.value}`);
                  focusField();
                }}
              >
                {choice.label()}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          onClick={() => {
            append("from:");
            focusField();
          }}
          className={cn(chipClass, "text-label-secondary hover:bg-fill-quaternary")}
        >
          {/* i18n-ignore: query syntax */}
          from:
        </button>
        {parsed.from.length > 0 ? (
          <span className="ms-1 text-callout text-label-tertiary">
            {t("screens.search.fromNote")}
          </span>
        ) : null}
      </div>

      <div className={cn("flex min-h-0 flex-1", palette && "overflow-hidden")}>
        <div className={cn("min-w-0 flex-1", palette && "overflow-y-auto p-1.5")}>{results}</div>
        {preview && current ? (
          <aside
            aria-label={t("shell.search.preview")}
            className={cn(
              "flex shrink-0 flex-col gap-3 p-4",
              current.kind === "entity" && renderEntityPreview ? "w-96" : "w-72",
              palette
                ? "overflow-y-auto border-s border-separator"
                : "rounded-lg bg-surface-raised shadow-elevation-1",
            )}
            data-testid="search-preview"
          >
            <SurfacePreview
              item={current}
              terms={terms}
              now={now}
              {...(renderEntityPreview ? { renderEntityPreview } : {})}
              onOpen={() => choose(current)}
              {...(onOpenInSideChat && current.kind === "hit"
                ? { onSideChat: () => choose(current, true) }
                : {})}
            />
          </aside>
        ) : null}
      </div>

      {palette ? (
        <div
          className="flex h-8 shrink-0 items-center gap-4 border-t border-separator px-3 text-subheadline text-label-tertiary"
          data-testid="search-hints"
        >
          <span className="inline-flex items-center gap-1">
            <Kbd>↵</Kbd> {t("shell.search.hintOpen")}
          </span>
          {onOpenInSideChat ? (
            <span className="inline-flex items-center gap-1">
              <Kbd>{isMac() ? "⌘↵" : t("shell.search.keyCtrlEnter")}</Kbd>{" "}
              {t("shell.search.hintSideChat")}
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1">
            <Kbd>{t("shell.search.keyTab")}</Kbd> {t("shell.search.hintFilter")}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function SurfaceRow({
  item,
  terms,
  now,
}: {
  item: SurfaceItem;
  terms: readonly string[];
  now: number;
}): ReactElement {
  if (item.kind === "entity") {
    const detail = entityDetail(item.entity, now);
    return (
      <>
        <EntityMonogram kind={item.entity.kind} name={item.entity.name} className="mx-0.5" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body font-medium text-label-primary">
            <Highlight text={item.entity.name} terms={terms} />
          </span>
          {detail ? (
            <>
              <span className="sr-only">: </span>
              <span className="truncate text-callout text-label-secondary">{detail}</span>
            </>
          ) : null}
        </span>
      </>
    );
  }
  if (item.kind === "action") {
    return (
      <>
        <span
          aria-hidden="true"
          className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-fill-tertiary text-label-secondary"
        >
          <Zap className="size-3.5" strokeWidth={1.75} />
        </span>
        <span className="min-w-0 flex-1 truncate text-body text-label-primary">
          {item.action.label}
        </span>
        {item.action.shortcut ? (
          <span className="shrink-0 text-subheadline text-label-tertiary">
            {item.action.shortcut}
          </span>
        ) : null}
      </>
    );
  }
  const { hit } = item;
  const Icon = SCOPE_ICON[hit.scope];
  return (
    <>
      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-fill-tertiary text-label-secondary"
      >
        <Icon className="size-3.5" strokeWidth={1.75} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body font-medium text-label-primary">
          <Highlight text={hit.title} terms={terms} />
        </span>
        <span className="sr-only">: </span>
        {hit.snippet ? (
          <span className="truncate text-callout text-label-secondary">
            <Highlight text={hit.snippet} terms={terms} />
          </span>
        ) : null}
      </span>
      {hit.scope === "memory" ? (
        <Badge variant="muted">
          <ShieldQuestion aria-hidden="true" />
          {t("screens.search.provenanceUnknown")}
        </Badge>
      ) : null}
    </>
  );
}

function SurfacePreview({
  item,
  terms,
  now,
  onOpen,
  onSideChat,
  renderEntityPreview,
}: {
  item: SurfaceItem;
  terms: readonly string[];
  now: number;
  onOpen: () => void;
  onSideChat?: () => void;
  renderEntityPreview?: (entity: EntitySummary) => ReactNode;
}): ReactElement {
  if (item.kind === "entity") {
    if (renderEntityPreview) return <>{renderEntityPreview(item.entity)}</>;
    const detail = entityDetail(item.entity, now);
    return (
      <>
        <span className="inline-flex items-center gap-1.5 text-caption text-label-tertiary">
          {t(`people.kind.${item.entity.kind}`)}
        </span>
        <p className="text-title-3 text-label-primary">
          <Highlight text={item.entity.name} terms={terms} />
        </p>
        {detail ? <p className="text-callout text-label-secondary">{detail}</p> : null}
        <div className="mt-auto flex flex-wrap gap-2">
          <Button size="sm" onClick={onOpen}>
            <CornerDownLeft aria-hidden="true" />
            {t("shell.search.open")}
          </Button>
        </div>
      </>
    );
  }
  if (item.kind === "action") {
    return (
      <>
        <p className="text-title-3 text-label-primary">{item.action.label}</p>
        <p className="text-callout text-label-secondary">{t("shell.search.actionHint")}</p>
        <div>
          <Button size="sm" onClick={onOpen}>
            {t("shell.search.run")}
          </Button>
        </div>
      </>
    );
  }
  const { hit } = item;
  const Icon = SCOPE_ICON[hit.scope];
  return (
    <>
      <span className="inline-flex items-center gap-1.5 text-caption text-label-tertiary">
        <Icon className="size-3.5" aria-hidden="true" strokeWidth={1.75} />
        {SCOPE_LABEL[hit.scope]}
      </span>
      <p className="text-title-3 text-label-primary">
        <Highlight text={hit.title} terms={terms} />
      </p>
      {hit.snippet ? (
        <p className="text-callout text-label-secondary whitespace-pre-wrap">
          <Highlight text={hit.snippet} terms={terms} />
        </p>
      ) : null}
      <div className="mt-auto flex flex-wrap gap-2">
        <Button size="sm" onClick={onOpen} disabled={hit.route == null}>
          <CornerDownLeft aria-hidden="true" />
          {t("shell.search.open")}
        </Button>
        {onSideChat ? (
          <Button size="sm" variant="outline" onClick={onSideChat}>
            {t("shell.search.openInSideChat")}
          </Button>
        ) : null}
      </div>
    </>
  );
}

/** Debounced search state shared by the Search page and ⌘K. */
export function useSearchSurface(initialQuery = "", debounceMs = 200, enabled = true) {
  const [query, setQuery] = useState(initialQuery);
  const [settled, setSettled] = useState(initialQuery);
  useEffect(() => {
    if (debounceMs === 0) {
      setSettled(query);
      return;
    }
    const timer = setTimeout(() => setSettled(query), debounceMs);
    return () => clearTimeout(timer);
  }, [query, debounceMs]);
  const settledParsed = useMemo(() => parseSearchQuery(settled), [settled]);
  const search = useSearch(
    enabled
      ? settledParsed.queryText === ""
        ? settledParsed.types.join(" ")
        : settledParsed.queryText
      : "",
    settledParsed.scopes,
  );
  const hits = useMemo(() => filterHits(search.hits, settledParsed), [search.hits, settledParsed]);
  const parsed = useMemo(() => parseSearchQuery(query), [query]);
  return {
    query,
    setQuery,
    parsed,
    hits,
    loading: search.loading || query !== settled,
    error: search.error,
    reload: search.reload,
  };
}

/** True when the window is at least `px` wide (the preview column needs 1080). */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const [wide, setWide] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const on = () => setWide(mql.matches);
    on();
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, [query]);
  return wide;
}
