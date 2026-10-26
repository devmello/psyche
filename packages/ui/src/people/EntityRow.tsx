import type { ReactElement } from "react";
import { t } from "../i18n/core.ts";
import { formatRelative } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { EntityMonogram } from "./glyphs.tsx";
import type { EntitySummary } from "./types.ts";

/** The callout line under a name: "Acme · last talked 2 days ago · 2 open loops" (spec §6.4). */
export function entityDetail(entity: EntitySummary, now: number): string {
  const parts: string[] = [];
  if (entity.subtitle) parts.push(entity.subtitle);
  if (entity.kind === "project" && entity.projectStatus)
    parts.push(t(`people.project.status.${entity.projectStatus}`));
  if (entity.lastInteractionAt)
    parts.push(t("people.row.lastTalked", { when: formatRelative(entity.lastInteractionAt, now) }));
  if (entity.openLoops > 0) parts.push(t("people.row.loops", { n: entity.openLoops }));
  return parts.join(" · ");
}

export interface EntityRowProps {
  entity: EntitySummary;
  now: number;
  selected?: boolean;
  onOpen?: (entity: EntitySummary) => void;
  /** Highlights matches in the name (Search). */
  renderName?: (name: string) => ReactElement | string;
  className?: string;
}

/**
 * One person or project in Search, ⌘K and the sheet list: a 20 px monogram, the name and a callout
 * line (spec §6.4). The whole row is one button.
 */
export function EntityRow({
  entity,
  now,
  selected = false,
  onOpen,
  renderName,
  className,
}: EntityRowProps): ReactElement {
  const detail = entityDetail(entity, now);
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={() => onOpen?.(entity)}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-start outline-none transition-colors duration-(--duration-micro) focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "bg-selection" : "hover:bg-fill-quaternary",
        className,
      )}
    >
      <EntityMonogram kind={entity.kind} name={entity.name} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-headline text-label-primary">
          {renderName ? renderName(entity.name) : entity.name}
        </span>
        {detail ? (
          <span className="truncate text-callout text-label-secondary">{detail}</span>
        ) : null}
      </span>
    </button>
  );
}
