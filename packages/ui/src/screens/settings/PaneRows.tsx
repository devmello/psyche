import { ChevronRight } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../../lib/utils.ts";
import { paneById, type SettingsPaneId } from "./settings-pages.ts";
import { CARD } from "./shared.tsx";

/**
 * Rows that open a pane one level deeper, the way System Settings drills in: the label, an
 * optional current value, a chevron. The pane keeps its route id, so deep links still land on it.
 */

export const DRILL_ROW =
  "flex min-h-11 w-full cursor-default items-center gap-3 px-4 py-2 text-start text-body text-label-primary outline-none transition-colors hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring";

export function DrillRow({
  label,
  value,
  icon,
  onOpen,
  className,
}: {
  label: string;
  value?: ReactNode;
  icon?: ReactNode;
  onOpen: () => void;
  className?: string;
}): ReactElement {
  return (
    <button type="button" onClick={onOpen} className={cn(DRILL_ROW, className)}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value !== undefined && value !== null ? (
        <span className="truncate text-callout text-label-secondary">{value}</span>
      ) : null}
      <ChevronRight className="size-4 shrink-0 text-label-tertiary" aria-hidden="true" />
    </button>
  );
}

function PaneRow({
  id,
  label,
  onOpen,
  className,
}: {
  id: SettingsPaneId;
  label?: string | undefined;
  onOpen: (pane: SettingsPaneId) => void;
  className?: string;
}): ReactElement {
  const pane = paneById(id);
  const Icon = pane?.icon;
  return (
    <DrillRow
      label={label ?? pane?.label ?? id}
      {...(className === undefined ? {} : { className })}
      icon={
        Icon === undefined ? undefined : (
          <Icon
            className="size-4 shrink-0 text-label-secondary"
            strokeWidth={1.75}
            aria-hidden="true"
          />
        )
      }
      onOpen={() => onOpen(id)}
    />
  );
}

export function PaneRows({
  panes,
  onOpen,
  labels,
  bare = false,
  className,
}: {
  panes: readonly SettingsPaneId[];
  onOpen: (pane: SettingsPaneId) => void;
  /** Row labels that differ from the pane's own name (the pane keeps its name for Search). */
  labels?: Partial<Record<SettingsPaneId, string>>;
  /** Inside a Group, which is already the card and draws the hairlines: just the rows. */
  bare?: boolean;
  className?: string;
}): ReactElement {
  if (bare) {
    return (
      <>
        {panes.map((id) => (
          <PaneRow key={id} id={id} label={labels?.[id]} onOpen={onOpen} />
        ))}
      </>
    );
  }
  return (
    <ul className={cn(CARD, "overflow-hidden", className)}>
      {panes.map((id) => (
        <li
          key={id}
          className="relative [&+li]:before:absolute [&+li]:before:inset-x-4 [&+li]:before:top-0 [&+li]:before:h-px [&+li]:before:bg-separator"
        >
          <PaneRow id={id} label={labels?.[id]} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}
