import type { EntitySummary, GraphWorkStatus } from "@psyche/protocol";
import { Lock } from "lucide-react";
import type { ReactElement } from "react";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { activeI18n, t } from "../i18n/core.ts";
import { formatDate } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { EntityMonogram } from "../people/glyphs.tsx";
import { dayNumber, isClosed, isOverdue, isStale } from "./work.ts";

/** "Not started", "In progress": the stored status of an assignment, in words. */
export function workStatusLabel(status: GraphWorkStatus | null | undefined): string {
  return t(`work.status.${status ?? "not_started"}`);
}

/** The due date in words: "Due today", "Due Thu", "Due Nov 6"; past due says since when. */
export function dueText(dueAt: string, now: number, overdue: boolean): string {
  if (overdue) return t("work.due.overdue", { date: formatDate(dueAt) });
  const days = dayNumber(Date.parse(dueAt)) - dayNumber(now);
  if (days === 0) return t("work.due.today");
  if (days === 1) return t("work.due.tomorrow");
  if (days > 1 && days < 7)
    return t("work.due.weekday", { day: activeI18n().date(dueAt, { weekday: "short" }) });
  return t("work.due.date", { date: formatDate(dueAt) });
}

/**
 * The due date as a quiet chip. Amber means it needs the owner, so only a past-due item that was
 * not handed in uses it, and the words say "Overdue" as well, never the colour alone.
 */
export function DueChip({
  dueAt,
  now,
  overdue,
  className,
}: {
  dueAt: string | null | undefined;
  now: number;
  overdue: boolean;
  className?: string;
}): ReactElement | null {
  if (!dueAt) return null;
  return (
    <span
      data-testid="due-chip"
      className={cn(
        "shrink-0 text-callout tabular-nums",
        overdue ? "text-approval-text" : "text-label-secondary",
        className,
      )}
    >
      {dueText(dueAt, now, overdue)}
    </span>
  );
}

/** "As of Oct 15" when a signal is known, else "No activity yet": the status may be out of date. */
export function StaleMark({
  lastSignalAt,
}: {
  lastSignalAt: string | null | undefined;
}): ReactElement {
  const text = lastSignalAt
    ? t("work.stale.asOf", { date: formatDate(lastSignalAt) })
    : t("work.stale.none");
  return (
    <span data-testid="stale-mark" title={t("work.stale.hint")} className="text-label-tertiary">
      {text}
    </span>
  );
}

export interface WorkRowProps {
  item: EntitySummary;
  now: number;
  onOpen: (id: string) => void;
  /** One-tap Done, and Reopen on a done row. */
  onSetStatus?: (item: EntitySummary, status: GraphWorkStatus) => void;
  busy?: boolean;
  /** Hide the parent (on the course's own page it is the page). */
  hideParent?: boolean;
}

/**
 * One assignment in Work due (§6.2): a Done checkbox, the title with its parent, status and stale
 * mark, and the due date. The title opens the item's page; the checkbox is the one-tap Done.
 */
export function WorkRow({
  item,
  now,
  onOpen,
  onSetStatus,
  busy = false,
  hideParent = false,
}: WorkRowProps): ReactElement {
  const closed = isClosed(item.workStatus);
  const overdue = isOverdue(item, now);
  const stale = isStale(
    {
      kind: "assignment",
      workStatus: item.workStatus,
      dueAt: item.dueAt,
      lastSignalAt: item.lastInteractionAt ?? undefined,
    },
    now,
  );
  const meta: ReactElement[] = [];
  if (!hideParent && item.subtitle) meta.push(<span key="parent">{item.subtitle}</span>);
  meta.push(<span key="status">{workStatusLabel(item.workStatus)}</span>);
  if (stale) meta.push(<StaleMark key="stale" lastSignalAt={item.lastInteractionAt} />);
  return (
    <div
      data-testid="work-row"
      className="relative flex min-h-12 items-center gap-1 px-3 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator first:before:hidden"
    >
      <Checkbox
        checked={closed}
        disabled={busy || !onSetStatus}
        aria-label={
          closed
            ? t("work.row.reopen", { name: item.name })
            : t("work.row.markDone", { name: item.name })
        }
        onCheckedChange={(on) => onSetStatus?.(item, on === true ? "done" : "in_progress")}
      />
      <button
        type="button"
        onClick={() => onOpen(item.id)}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 text-start outline-none transition-colors duration-(--duration-micro) hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "truncate text-body",
                closed ? "text-label-tertiary line-through" : "text-label-primary",
              )}
            >
              {item.name}
            </span>
            {item.private ? (
              <Lock
                aria-hidden="true"
                className="size-3 shrink-0 text-label-tertiary"
                data-testid="private-mark"
              />
            ) : null}
            {item.private ? <span className="sr-only">{t("work.privateMark")}</span> : null}
          </span>
          <span className="flex flex-wrap items-center gap-x-1.5 text-callout text-label-secondary">
            {meta.map((m, i) => (
              <span key={m.key} className="flex items-center gap-1.5">
                {i > 0 ? <span aria-hidden="true">·</span> : null}
                {m}
              </span>
            ))}
          </span>
        </span>
        <DueChip dueAt={item.dueAt} now={now} overdue={overdue} />
      </button>
    </div>
  );
}

/** A project or course in the Projects tab: the monogram, name, status, due and stale mark. */
export function ProjectRow({
  item,
  now,
  onOpen,
}: {
  item: EntitySummary;
  now: number;
  onOpen: (id: string) => void;
}): ReactElement {
  const course = item.projectType === "course";
  const stale = isStale(
    {
      kind: "project",
      projectStatus: item.projectStatus,
      lastSignalAt: item.lastInteractionAt ?? undefined,
    },
    now,
  );
  const meta: ReactElement[] = [];
  meta.push(<span key="kind">{course ? t("work.kind.course") : t("people.kind.project")}</span>);
  if (item.projectStatus && item.projectStatus !== "active")
    meta.push(<span key="status">{t(`people.project.status.${item.projectStatus}`)}</span>);
  if (item.openLoops > 0)
    meta.push(<span key="loops">{t("people.row.loops", { n: item.openLoops })}</span>);
  if (stale) meta.push(<StaleMark key="stale" lastSignalAt={item.lastInteractionAt} />);
  return (
    <button
      type="button"
      data-testid="project-row"
      onClick={() => onOpen(item.id)}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-start outline-none transition-colors duration-(--duration-micro) hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
    >
      <EntityMonogram kind={item.kind} name={item.name} course={course} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-headline text-label-primary">{item.name}</span>
          {item.private ? (
            <>
              <Lock aria-hidden="true" className="size-3 shrink-0 text-label-tertiary" />
              <span className="sr-only">{t("work.privateMark")}</span>
            </>
          ) : null}
        </span>
        <span className="flex flex-wrap items-center gap-x-1.5 text-callout text-label-secondary">
          {meta.map((m, i) => (
            <span key={m.key} className="flex items-center gap-1.5">
              {i > 0 ? <span aria-hidden="true">·</span> : null}
              {m}
            </span>
          ))}
        </span>
      </span>
      {item.dueAt ? <DueChip dueAt={item.dueAt} now={now} overdue={false} /> : null}
    </button>
  );
}
