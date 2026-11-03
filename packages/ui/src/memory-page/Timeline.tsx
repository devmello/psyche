import type { GraphFactAttribute, GraphTimelineRow } from "@psyche/protocol";
import {
  Bookmark,
  CalendarClock,
  CircleSlash,
  ExternalLink,
  Flag,
  Hourglass,
  ListChecks,
  type LucideIcon,
  MoveRight,
} from "lucide-react";
import { type ReactElement, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { formatRelative } from "../lib/format.ts";
import { useOpenLink } from "../links/LinkPrompt.tsx";
import { INTERACTION_ICON, ProvenanceGlyph } from "../people/glyphs.tsx";

/** One row's icon: the kind of interaction, or the work fact that changed. */
const FACT_ICON: Partial<Record<GraphFactAttribute, LucideIcon>> = {
  status: Flag,
  deadline: CalendarClock,
  stopped_at: Bookmark,
  next_step: MoveRight,
  progress: ListChecks,
  blocked_on: CircleSlash,
};

function iconFor(row: GraphTimelineRow): LucideIcon {
  if (row.kind === "interaction" && row.interactionKind)
    return INTERACTION_ICON[row.interactionKind];
  if (row.kind === "fact" && row.change) return FACT_ICON[row.change.attribute] ?? Flag;
  return Hourglass;
}

/**
 * The citation chip of a row (§3.5): "Reminders · MATH 21", "Files · hw7.tex"; a row that carries
 * someone else's words says whose: "From Canvas's mail". The label is data, shown as plain text.
 */
export function chipText(row: GraphTimelineRow): string | null {
  const chip = row.chip;
  if (!chip) return null;
  const source = t(`work.source.${chip.source}`);
  const noun = t(`work.noun.${chip.source}`);
  // "Files · files" and "From calendar's calendar" say it twice: when the label is only the
  // source's own name, give the source once.
  const label = chip.label.trim().toLowerCase();
  if (label === source.toLowerCase() || label === noun.toLowerCase()) return source;
  if (row.provenance === "untrusted")
    return t("work.chip.from", { name: chip.label, source: noun });
  return t("work.chip.label", { source, label: chip.label });
}

export interface TimelineProps {
  rows: readonly GraphTimelineRow[];
  now: number;
  /** Names of the assignments a course's rows come from, by id. */
  names?: ReadonlyMap<string, string>;
  /** The item the timeline belongs to: its own rows carry no name tag. */
  rootId: string;
  hasMore?: boolean;
  loadingMore?: boolean;
  onMore?: () => void;
  onOpenLink?: (link: string) => void;
}

/**
 * An item's timeline (§3.5), newest first: mail and messages, file days, reminders, Psyche runs,
 * the moves of its due date and status, and loops. Every row carries its source chip. Text is a
 * template with titles as data, never Markdown or a link; a course's rows from its assignments
 * start with the assignment's name.
 */
export function Timeline({
  rows,
  now,
  names,
  rootId,
  hasMore = false,
  loadingMore = false,
  onMore,
  onOpenLink,
}: TimelineProps): ReactElement {
  if (rows.length === 0)
    return <p className="px-3 py-2 text-body text-label-secondary">{t("work.timeline.empty")}</p>;
  return (
    <>
      {rows.map((row) => {
        const Icon = iconFor(row);
        const chip = chipText(row);
        const from = row.entityId !== rootId ? names?.get(row.entityId) : undefined;
        const link = row.chip?.link ?? null;
        return (
          <div
            key={row.id}
            data-testid="timeline-row"
            className="relative flex min-h-9 items-start gap-3 px-3 py-2 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator first:before:hidden"
          >
            <Icon className="mt-0.5 size-4 shrink-0 text-label-secondary" aria-hidden="true" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-body text-label-primary">
                {from ? <span className="text-label-secondary">{from} · </span> : null}
                {row.text}
              </span>
              <span className="flex flex-wrap items-center gap-x-1 text-callout text-label-secondary">
                <ProvenanceGlyph provenance={row.provenance} />
                {chip ? <span data-testid="timeline-chip">{chip}</span> : null}
                {chip ? <span aria-hidden="true">·</span> : null}
                <span>{formatRelative(row.at, now)}</span>
              </span>
            </div>
            {link && onOpenLink ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="shrink-0 text-label-secondary"
                aria-label={t("work.timeline.open", { source: chip ?? "" })}
                title={t("people.source.open")}
                onClick={() => onOpenLink(link)}
              >
                <ExternalLink aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        );
      })}
      {hasMore ? (
        <div className="px-3 py-1.5">
          <Button type="button" size="sm" variant="ghost" disabled={loadingMore} onClick={onMore}>
            {t("work.timeline.older")}
          </Button>
        </div>
      ) : null}
    </>
  );
}

const PAGE = 20;

/** The timeline of one entity from `memory.entities.timeline`, with older rows on request. */
export function ConnectedTimeline({
  entityId,
  now,
  names,
}: {
  entityId: string;
  now: number;
  names?: ReadonlyMap<string, string>;
}): ReactElement {
  const call = useCall();
  const openLink = useOpenLink();
  const first = useGatewayQuery("memory.entities.timeline", { entityId, limit: PAGE });
  const [older, setOlder] = useState<{ rows: GraphTimelineRow[]; next: string | null } | null>(
    null,
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const head = first.data?.rows ?? [];
  const seen = new Set(head.map((r) => r.id));
  const rows = [...head, ...(older?.rows ?? []).filter((r) => !seen.has(r.id))];
  const next = older ? older.next : (first.data?.nextBefore ?? null);

  const more = () => {
    if (next === null) return;
    setLoadingMore(true);
    setError(null);
    call("memory.entities.timeline", { entityId, before: next, limit: PAGE })
      .then((res) =>
        setOlder((o) => ({
          rows: [...(o?.rows ?? []), ...res.rows],
          next: res.nextBefore ?? null,
        })),
      )
      .catch((err: unknown) => setError(describeError(err)))
      .finally(() => setLoadingMore(false));
  };

  if (first.error && !first.data)
    return (
      <p className="px-3 py-2 text-body text-label-secondary">
        {t("work.timeline.failed", { reason: first.error })}
      </p>
    );
  return (
    <>
      <Timeline
        rows={rows}
        now={now}
        rootId={entityId}
        hasMore={next !== null}
        loadingMore={loadingMore}
        onMore={more}
        onOpenLink={openLink}
        {...(names ? { names } : {})}
      />
      {error ? (
        <p className="px-3 pb-2 text-callout text-label-secondary">
          {t("work.timeline.failed", { reason: error })}
        </p>
      ) : null}
    </>
  );
}
