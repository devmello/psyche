import type { MemoryMap } from "@psyche/protocol";
import { Network } from "lucide-react";
import { type ReactElement, useId, useMemo, useRef, useState } from "react";
import { EmptyState, ErrorState, LoadingCards } from "../../components/page.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";
import { MapCanvas } from "./MapCanvas.tsx";
import { EDGE_STYLES, shapeOf } from "./map-draw.ts";
import {
  ALL_GROUPS,
  buildMapModel,
  focusModel,
  isSparse,
  MAP_GROUPS,
  type MapGroup,
  quietPeople,
  sameMap,
  searchNodes,
  topNodes,
} from "./map-model.ts";

/** How many entities the map asks for. The Gateway keeps the most important and says so. */
export const MAP_LIMIT = 2000;

export interface MemoryMapViewProps {
  /** Opens an entity's page (its existing detail). */
  onOpen: (id: string) => void;
}

/**
 * The Memory page's Map view (List | Map): people, projects, events and topics as a graph sized by
 * importance, joined by the relations Psyche already holds. Search finds a node and focuses on its
 * neighbourhood; clicking a node opens its page. Data: `memory.graph.map`, read-only.
 */
export function MemoryMapView({ onOpen }: MemoryMapViewProps): ReactElement {
  const q = useGatewayQuery("memory.graph.map", { limit: MAP_LIMIT });
  if (q.data === undefined) {
    if (q.error)
      return (
        <ErrorState what={t("memory.map.loadFailed")} reason={null} retry={{ onClick: q.reload }} />
      );
    return <LoadingCards label={t("memory.map.loading")} layout="stack" count={1} lines={6} />;
  }
  if (q.data.nodes.length === 0)
    return <EmptyState icon={Network}>{t("memory.map.empty")}</EmptyState>;
  return <StableMap data={q.data} onOpen={onOpen} />;
}

/** A refetch that returns the same map keeps the same object, so nothing is rebuilt or redrawn. */
function StableMap({
  data,
  onOpen,
}: {
  data: MemoryMap;
  onOpen: (id: string) => void;
}): ReactElement {
  const kept = useRef(data);
  if (kept.current !== data && !sameMap(kept.current, data)) kept.current = data;
  return <MapWorkspace data={kept.current} onOpen={onOpen} />;
}

function GroupGlyph({ group }: { group: MapGroup }): ReactElement {
  const pts = shapeOf(group);
  return (
    <svg viewBox="-1.4 -1.4 2.8 2.8" className="size-3.5 shrink-0" aria-hidden="true">
      {pts === null ? (
        <circle r="1" fill="currentColor" />
      ) : (
        <polygon points={pts.map((p) => p.join(",")).join(" ")} fill="currentColor" />
      )}
    </svg>
  );
}

function MapWorkspace({
  data,
  onOpen,
}: {
  data: MemoryMap;
  onOpen: (id: string) => void;
}): ReactElement {
  const [groups, setGroups] = useState<ReadonlySet<MapGroup>>(ALL_GROUPS);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [quietOnly, setQuietOnly] = useState(false);
  const [cursor, setCursor] = useState(0);
  const listId = useId();

  const base = useMemo(() => buildMapModel(data, { groups }), [data, groups]);
  const model = useMemo(
    () => (focusId === null ? base : focusModel(base, focusId)),
    [base, focusId],
  );
  const focused = focusId === null ? undefined : base.nodes[base.index.get(focusId) ?? -1];
  const matches = useMemo(() => searchNodes(base, query), [base, query]);
  const quiet = useMemo(() => quietPeople(base), [base]);
  const listed = useMemo(() => topNodes(model, 60), [model]);
  const sparse = isSparse(model);

  const toggle = (g: MapGroup) =>
    setGroups((cur) => {
      const next = new Set(cur);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next.size === 0 ? ALL_GROUPS : next;
    });
  const focusOn = (id: string) => {
    setFocusId(id);
    setQuery("");
    setCursor(0);
  };

  return (
    <div className="flex flex-col gap-3" data-testid="memory-map">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Input
            type="search"
            role="combobox"
            aria-label={t("memory.map.search")}
            aria-expanded={query.trim() !== ""}
            aria-controls={query.trim() !== "" ? listId : undefined}
            aria-autocomplete="list"
            placeholder={t("memory.map.search.placeholder")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(matches.length - 1, c + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(0, c - 1));
              } else if (e.key === "Enter") {
                const hit = matches[cursor];
                if (hit) focusOn(hit.id);
              } else if (e.key === "Escape") setQuery("");
            }}
          />
          {query.trim() !== "" ? (
            <div
              id={listId}
              role="listbox"
              aria-label={t("memory.map.search.results")}
              className="absolute inset-x-0 top-full z-10 mt-1 max-h-64 overflow-auto rounded-lg bg-surface-raised p-1 shadow-elevation-2"
            >
              {matches.length === 0 ? (
                <p className="px-2 py-1.5 text-callout text-label-secondary">
                  {t("memory.map.search.none", { q: query.trim() })}
                </p>
              ) : (
                matches.map((m, i) => (
                  <div key={m.id} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === cursor}
                      onClick={() => focusOn(m.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-body outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring",
                        i === cursor && "bg-selection",
                      )}
                    >
                      <GroupGlyph group={m.group} />
                      <span className="min-w-0 flex-1 truncate">{m.name}</span>
                      <span className="text-caption text-label-tertiary">
                        {t(`memory.map.kind.${m.kind}`)}
                      </span>
                    </button>
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>

        <fieldset
          aria-label={t("memory.map.filters")}
          className="m-0 flex min-w-0 flex-wrap items-center gap-1 border-0 p-0"
        >
          {MAP_GROUPS.map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={groups.has(g)}
              onClick={() => toggle(g)}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-full px-3 text-callout outline-none transition-colors duration-(--duration-micro) focus-visible:ring-2 focus-visible:ring-ring",
                groups.has(g)
                  ? "bg-selection text-label-primary"
                  : "text-label-tertiary hover:bg-fill-quaternary",
              )}
            >
              <GroupGlyph group={g} />
              {t(`memory.map.group.${g}`)}
            </button>
          ))}
          {quiet.length > 0 ? (
            <button
              type="button"
              aria-pressed={quietOnly}
              onClick={() => setQuietOnly((v) => !v)}
              data-testid="memory-map-quiet"
              className={cn(
                "h-7 rounded-full px-3 text-callout outline-none transition-colors duration-(--duration-micro) focus-visible:ring-2 focus-visible:ring-ring",
                quietOnly
                  ? "bg-selection text-label-primary"
                  : "text-label-secondary hover:bg-fill-quaternary",
              )}
            >
              {t("memory.map.quiet", { n: quiet.length })}
            </button>
          ) : null}
        </fieldset>
      </div>

      {focused ? (
        <div
          className="flex flex-wrap items-center gap-2 text-callout text-label-secondary"
          data-testid="memory-map-focus"
        >
          <span>
            {t("memory.map.focus.showing", {
              name: focused.name,
              n: Math.max(0, model.nodes.length - 1),
            })}
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setFocusId(null)}>
            {t("memory.map.focus.clear")}
          </Button>
        </div>
      ) : null}

      <div className="relative">
        <MapCanvas
          model={model}
          focusId={focusId}
          quietOnly={quietOnly}
          onOpen={onOpen}
          onFocus={focusOn}
        />
        {/* The same items as buttons, for the keyboard and screen readers; visible while focused. */}
        <ul
          aria-label={t("memory.map.list.label")}
          className="sr-only focus-within:not-sr-only focus-within:absolute focus-within:inset-x-2 focus-within:top-2 focus-within:z-10 focus-within:max-h-48 focus-within:overflow-auto focus-within:rounded-lg focus-within:bg-surface-raised focus-within:p-1 focus-within:shadow-elevation-2"
        >
          {listed.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => onOpen(n.id)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-start text-body outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <GroupGlyph group={n.group} />
                <span className="truncate">{n.name}</span>
                <span className="text-caption text-label-tertiary">
                  {t(`memory.map.kind.${n.kind}`)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-label-tertiary">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{t("memory.map.legend")}</span>
          {(Object.keys(EDGE_STYLES) as (keyof typeof EDGE_STYLES)[]).map((k) => (
            <span key={k} className="flex items-center gap-1.5">
              <svg width="22" height="6" aria-hidden="true">
                <line
                  x1="1"
                  y1="3"
                  x2="21"
                  y2="3"
                  stroke="currentColor"
                  strokeWidth={EDGE_STYLES[k].width}
                  strokeDasharray={EDGE_STYLES[k].dash.join(" ") || undefined}
                  strokeLinecap="round"
                />
              </svg>
              {t(`memory.map.edge.${k}`)}
            </span>
          ))}
        </span>
        {base.truncated ? (
          <span>{t("memory.map.truncated", { shown: base.nodes.length, total: base.total })}</span>
        ) : null}
      </div>
      {sparse ? (
        <p className="text-callout text-label-secondary" data-testid="memory-map-sparse">
          {t("memory.map.sparse")}
        </p>
      ) : null}
    </div>
  );
}
