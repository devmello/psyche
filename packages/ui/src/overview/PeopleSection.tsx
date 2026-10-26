import type { InsightEntity } from "@psyche/protocol";
import {
  type ReactElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import type { CardAction } from "../blocks/card.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { useGatewayQuery } from "../data/index.ts";
import { useInsights } from "../data/insights.ts";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { usePersona, useSlots } from "../slots.tsx";
import { periodMeta } from "./GrowthSection.tsx";
import { OverviewSection } from "./OverviewSection.tsx";
import { entityFacts, kindLabel, PeopleMap } from "./PeopleMap.tsx";
import { MAP_LIMIT, rankEntities, shapeOf } from "./peopleLayout.ts";
import type { OverviewPeriod } from "./period.ts";
import { SectionBody, useSectionStatus } from "./SectionState.tsx";

/** Below this container width the list is the default view (§5.4: "the map has the list equivalent"). */
const COMPACT_BELOW = 720;
/** Names in the ranked line under the map. */
const RANKED_SHOWN = 5;

export const soulEntityHref = (entityId: string): string =>
  `/agent/soul?entity=${encodeURIComponent(entityId)}`;

/** True while the nearest `@container/overview` ancestor is narrower than `COMPACT_BELOW`. */
function useCompact(ref: RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = ref.current?.closest("[data-testid='overview']") ?? ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setCompact(entry.contentRect.width < COMPACT_BELOW);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return compact;
}

export interface PeopleSectionProps {
  period: OverviewPeriod;
  /** Epoch ms for the recency rings (stories pin it). */
  now?: number;
  /** Forces the compact default (the list) regardless of width; for stories and tests. */
  compact?: boolean;
}

/**
 * People & projects (docs/design/agent-overview-2026.md §5.4): the radial map of the people
 * and projects the agent works with most in the period, its counts and ranked line, and the
 * list equivalent. Data: `insights.summary.topEntities` and `memory.graph.status`.
 */
export function PeopleSection({ period, now, compact }: PeopleSectionProps): ReactElement {
  const persona = usePersona();
  const { navigate } = useSlots();
  const insights = useInsights(period);
  const status = useGatewayQuery("memory.graph.status", {});
  const root = useRef<HTMLDivElement>(null);
  const measured = useCompact(root);
  const narrow = compact ?? measured;
  // `undefined` follows the width; a choice made with the toggle wins until the width flips.
  const [choice, setChoice] = useState<{ list: boolean; narrow: boolean } | null>(null);
  const list = choice !== null && choice.narrow === narrow ? choice.list : narrow;
  const [mountedAt] = useState(() => Date.now());
  const at = now ?? mountedAt;

  const entities = insights.data?.topEntities ?? [];
  const paused = status.data !== undefined && !status.data.enabled;
  const open = (entityId: string) => navigate?.(soulEntityHref(entityId));

  const actions: CardAction[] = [];
  if (!paused && entities.length > 0) {
    actions.push({
      id: "toggle-view",
      label: list ? t("overview.people.showMap") : t("overview.people.showList"),
      kind: "open",
      onSelect: () => setChoice({ list: !list, narrow }),
    });
    actions.push({
      id: "see-all",
      label: t("overview.people.seeAll"),
      kind: "open",
      onSelect: () => navigate?.("/agent/soul"),
    });
  }

  const loadStatus = useSectionStatus("people", [
    { ...insights, has: insights.data !== undefined, key: period },
    { ...status, has: status.data !== undefined, key: "graph" },
  ]);
  let body: ReactNode;
  if (insights.data === undefined || status.data === undefined) {
    body = (
      <SectionBody
        id="people"
        status={loadStatus}
        reserve="min-h-56"
        skeleton={
          <>
            <Skeleton className="h-40" />
            <Skeleton className="h-5 w-2/3" />
          </>
        }
      >
        {null}
      </SectionBody>
    );
  } else if (paused) {
    body = (
      <p className="text-callout text-label-tertiary" data-testid="people-paused">
        {t("overview.people.paused")}
      </p>
    );
  } else if (entities.length === 0) {
    body = (
      <p className="text-callout text-label-tertiary" data-testid="people-empty">
        {t("overview.people.empty", { agent: persona.name })}
      </p>
    );
  } else {
    const ranked = rankEntities(entities).slice(0, MAP_LIMIT);
    body = (
      <div className="flex flex-col gap-3" data-testid="overview-people">
        {list ? (
          <PeopleList entities={ranked} now={at} onOpen={open} />
        ) : (
          <PeopleMap entities={ranked} now={at} onOpen={open} rtl={isRtl()} />
        )}
        <Counts counts={status.data?.counts} />
        <RankedLine entities={ranked} onOpen={open} />
      </div>
    );
  }

  return (
    <div ref={root} className="contents">
      <OverviewSection id="people" meta={periodMeta(period)} actions={actions}>
        {body}
      </OverviewSection>
    </div>
  );
}

const isRtl = (): boolean =>
  typeof document !== "undefined" && document.documentElement.dir === "rtl";

/** "14 people · 6 projects · 5 open loops", from `memory.graph.status`. */
function Counts({
  counts,
}: {
  counts: { people: number; projects: number; openLoops: number } | undefined;
}): ReactElement | null {
  if (counts === undefined) return null;
  return (
    <p className="text-callout text-label-secondary tabular-nums" data-testid="people-counts">
      {t("overview.people.counts", {
        people: counts.people,
        projects: counts.projects,
        loops: counts.openLoops,
      })}
    </p>
  );
}

/** "Ana 31 · Q4 board deck 22 · …": the leaders and their interactions, each opening the entity. */
function RankedLine({
  entities,
  onOpen,
}: {
  entities: readonly InsightEntity[];
  onOpen: (id: string) => void;
}): ReactElement {
  const shown = entities.slice(0, RANKED_SHOWN);
  return (
    <p className="text-callout text-label-secondary" data-testid="people-ranked">
      {shown.map((e, i) => (
        <span key={e.entityId}>
          {i > 0 ? <span aria-hidden="true"> · </span> : null}
          <button
            type="button"
            onClick={() => onOpen(e.entityId)}
            className="rounded-sm tabular-nums outline-none hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("overview.people.ranked", { name: e.name, n: e.interactions })}
          </button>
        </span>
      ))}
      {entities.length > shown.length ? <span aria-hidden="true"> · …</span> : null}
    </p>
  );
}

/** The map's equivalent: the same entities in the same rank order, as plain rows. */
export function PeopleList({
  entities,
  now,
  onOpen,
}: {
  entities: readonly InsightEntity[];
  now: number;
  onOpen: (id: string) => void;
}): ReactElement {
  return (
    <ol
      aria-label={t("overview.people.list")}
      className="flex flex-col divide-y divide-separator"
      data-testid="people-list"
    >
      {entities.map((e) => {
        const f = entityFacts(e, now);
        return (
          <li key={e.entityId}>
            <button
              type="button"
              onClick={() => onOpen(e.entityId)}
              data-testid="people-row"
              className="flex min-h-8 w-full items-center gap-3 rounded-sm py-1.5 text-start outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-3 shrink-0 border-2 border-accent-9 bg-accent-a4",
                  shapeOf(e.kind) === "circle" ? "rounded-full" : "rounded-[3px]",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body text-label-primary">{e.name}</span>
                <span className="block truncate text-caption text-label-secondary">
                  {kindLabel(e.kind)} · {t("overview.people.last", { when: f.last })}
                </span>
              </span>
              <span className="flex flex-col items-end text-caption text-label-secondary tabular-nums">
                <span>{f.interactions}</span>
                {e.openLoops > 0 ? <span>{f.loops}</span> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
