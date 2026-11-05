import { Plus } from "lucide-react";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { GroupedList } from "../components/page.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { activeI18n, t } from "../i18n/core.ts";
import { formatDate } from "../lib/format.ts";
import {
  CardFrame,
  CardHeader,
  EdgeRow,
  EmptyRow,
  type EntityCardProps,
  FactRows,
  LoopRows,
  NotesEditor,
  Summary,
} from "../people/EntityCard.tsx";
import { FactRow } from "../people/FactRow.tsx";
import { EntityMonogram } from "../people/glyphs.tsx";
import type { EntityView, FactView, GraphFactAttribute, ProjectStatus } from "../people/types.ts";
import { SegmentedRadio } from "../screens/settings/SegmentedRadio.tsx";
import { WorkRow, workStatusLabel } from "./WorkRow.tsx";
import {
  fromDateInput,
  isClosed,
  isOverdue,
  isStale,
  isStaleFact,
  toDateInput,
  WORK_STATUSES,
} from "./work.ts";

const PROJECT_STATUSES: readonly ProjectStatus[] = ["active", "paused", "done"];

/** Work facts the card shows in their own place, so the Facts list leaves them out. */
const SHOWN_ELSEWHERE: ReadonlySet<GraphFactAttribute> = new Set([
  "status",
  "stopped_at",
  "next_step",
]);

const label = "text-body text-label-secondary";

/** "Where you stopped" or "Next step": the current value, or one tap to say it. */
function CurrentFact({
  entity,
  attribute,
  now,
  busy,
  onSet,
  onRetract,
}: {
  entity: EntityView;
  attribute: Extract<GraphFactAttribute, "stopped_at" | "next_step">;
  now: number;
  busy: boolean;
  onSet?: (entity: EntityView, attribute: GraphFactAttribute, value: string) => void;
  onRetract?: (entity: EntityView, fact: FactView) => void;
}): ReactElement {
  const id = useId();
  const fact = entity.facts
    .filter((f) => f.attribute === attribute)
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))[0];
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const title = t(`people.attr.${attribute}`);
  if (fact)
    return (
      <FactRow
        fact={fact}
        busy={busy}
        stale={isStaleFact(fact.recordedAt, now)}
        hideAttribute
        {...(onSet ? { onSet: (f: FactView, v: string) => onSet(entity, f.attribute, v) } : {})}
        {...(onRetract ? { onRetract: (f: FactView) => onRetract(entity, f) } : {})}
      />
    );
  if (!onSet) return <EmptyRow>{t(`work.empty.${attribute}`)}</EmptyRow>;
  if (!open)
    return (
      <div className="flex min-h-9 items-center gap-2 px-3 py-1.5">
        <span className="text-body text-label-secondary">{t(`work.empty.${attribute}`)}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-accent-11"
          onClick={() => setOpen(true)}
        >
          {t(`work.set.${attribute}`)}
        </Button>
      </div>
    );
  return (
    <form
      className="flex min-h-9 items-center gap-2 px-3 py-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        const value = draft.trim();
        if (value === "") return;
        onSet(entity, attribute, value);
        setDraft("");
        setOpen(false);
      }}
    >
      <label htmlFor={id} className="sr-only">
        {title}
      </label>
      <Input
        id={id}
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        className="h-7 min-w-0 flex-1"
      />
      <Button type="submit" size="sm" disabled={busy || draft.trim() === ""}>
        {t("people.fact.save")}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
        {t("people.fact.cancel")}
      </Button>
    </form>
  );
}

/** The due date in full, with Change: a date field that saves 11:59 pm that day. */
function DueRow({
  entity,
  now,
  busy,
  overdue,
  onSetDueAt,
}: {
  entity: EntityView;
  now: number;
  busy: boolean;
  overdue: boolean;
  onSetDueAt?: (entity: EntityView, dueAt: string | null) => void;
}): ReactElement {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const due = entity.dueAt ?? null;
  const full = due
    ? activeI18n().dateTime(due, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className={label}>{t("work.due.label")}</span>
      {editing ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const iso = fromDateInput(draft);
            if (iso === null) return;
            onSetDueAt?.(entity, iso);
            setEditing(false);
          }}
        >
          <label htmlFor={id} className="sr-only">
            {t("work.due.field")}
          </label>
          <Input
            id={id}
            type="date"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
            }}
            className="h-7 w-40"
          />
          <Button type="submit" size="sm" disabled={busy || fromDateInput(draft) === null}>
            {t("people.fact.save")}
          </Button>
          {due ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                onSetDueAt?.(entity, null);
                setEditing(false);
              }}
            >
              {t("work.due.clear")}
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
            {t("people.fact.cancel")}
          </Button>
        </form>
      ) : (
        <span className="flex items-center gap-2">
          {due && full ? (
            <span
              data-testid="due-full"
              className={`text-body tabular-nums ${overdue ? "text-approval-text" : "text-label-primary"}`}
            >
              {overdue
                ? t("work.due.overdueFull", { when: full })
                : t("work.due.full", { when: full })}
            </span>
          ) : (
            <span className="text-body text-label-secondary">{t("work.due.none")}</span>
          )}
          {onSetDueAt ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDraft(due ? toDateInput(due) : toDateInput(new Date(now).toISOString()));
                setEditing(true);
              }}
            >
              {due ? t("work.due.change") : t("work.due.set")}
            </Button>
          ) : null}
        </span>
      )}
    </div>
  );
}

export interface WorkCardProps extends EntityCardProps {
  /** The item's timeline (`ConnectedTimeline`, or rows for a story). */
  timeline?: ReactNode;
  /** The History section's rows (`ConnectedWorkHistory`). */
  history?: ReactNode;
  /** The Linked section's rows (`ConnectedAnchors`). */
  linked?: ReactNode;
  /** Quick add inside a course or project: the form, given a way to close it. */
  addAssignment?: (close: () => void) => ReactNode;
}

/**
 * The page of a project, course or assignment (docs/design/memory-everything-2026.md §6.3), which
 * `ProjectCard` grew into. It leads with where the work stands: a status control, the due date,
 * where you stopped and the next step, each with its source and a note when it may be out of date.
 * A course lists its assignments with a one-tap Done; every item has its People, open loops,
 * Timeline and Linked sources. ⋯ keeps it private. Every write goes through the host.
 */
export function WorkCard({
  entity,
  now,
  persona = "Wren",
  loading = false,
  loadingDelayMs = 0,
  error = null,
  onRetry,
  recentLimit: _recentLimit,
  busy = false,
  className,
  timeline,
  history,
  linked,
  addAssignment,
  ...actions
}: WorkCardProps): ReactElement {
  const [adding, setAdding] = useState(false);
  return (
    <CardFrame
      entity={entity}
      loading={loading}
      loadingDelayMs={loadingDelayMs}
      error={error}
      {...(onRetry ? { onRetry } : {})}
      {...(className ? { className } : {})}
    >
      {(e) => {
        const assignment = e.kind === "assignment";
        const overdue =
          assignment && isOverdue({ workStatus: e.workStatus, dueAt: e.dueAt ?? null }, now);
        const stale = isStale(
          {
            kind: assignment ? "assignment" : "project",
            workStatus: e.workStatus,
            projectStatus: e.projectStatus,
            dueAt: e.dueAt,
            lastSignalAt: e.lastSignalAt,
          },
          now,
        );
        const closed = assignment ? isClosed(e.workStatus) : e.projectStatus === "done";
        const people = e.edges.filter(
          (edge) => edge.other.kind === "person" || edge.other.kind === "org",
        );
        const members = assignment ? [] : people;
        const assignments = [...(e.assignments ?? [])].sort((a, b) => {
          const rank = (x: typeof a) => (isClosed(x.workStatus) ? 1 : 0);
          return (
            rank(a) - rank(b) ||
            (a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY) -
              (b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY)
          );
        });
        const names = [...(e.parent ? [e.parent] : []), ...(e.assignedBy ? [e.assignedBy] : [])];
        const otherFacts = e.facts.filter(
          (f) =>
            !SHOWN_ELSEWHERE.has(f.attribute) &&
            !(f.attribute === "deadline" && e.dueAt && !Number.isNaN(Date.parse(f.value))),
        );
        return (
          <>
            <CardHeader entity={e} actions={actions} />
            <Summary entity={e} />
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={label}>{t("people.project.status")}</span>
                <div className="max-w-full overflow-x-auto">
                  {assignment ? (
                    <SegmentedRadio
                      label={t("people.project.status")}
                      value={e.workStatus ?? "not_started"}
                      disabled={busy || !actions.onSetWorkStatus}
                      options={WORK_STATUSES.map((s) => ({ value: s, label: workStatusLabel(s) }))}
                      onChange={(s) => actions.onSetWorkStatus?.(e, s)}
                    />
                  ) : (
                    <SegmentedRadio
                      label={t("people.project.status")}
                      value={e.projectStatus ?? "active"}
                      disabled={busy || !actions.onSetStatus}
                      options={PROJECT_STATUSES.map((s) => ({
                        value: s,
                        label: t(`people.project.status.${s}`),
                      }))}
                      onChange={(s) => actions.onSetStatus?.(e, s)}
                    />
                  )}
                </div>
              </div>
              <DueRow
                entity={e}
                now={now}
                busy={busy}
                overdue={overdue}
                {...(actions.onSetDueAt ? { onSetDueAt: actions.onSetDueAt } : {})}
              />
              {stale && !closed ? (
                <p data-testid="stale-note" className="text-callout text-label-tertiary">
                  {e.lastSignalAt
                    ? t("work.stale.card", { date: formatDate(e.lastSignalAt) })
                    : t("work.stale.cardNone")}
                </p>
              ) : null}
            </div>
            <GroupedList title={t("people.attr.stopped_at")}>
              <CurrentFact
                entity={e}
                attribute="stopped_at"
                now={now}
                busy={busy}
                {...(actions.onSetFact ? { onSet: actions.onSetFact } : {})}
                {...(actions.onRetractFact ? { onRetract: actions.onRetractFact } : {})}
              />
            </GroupedList>
            <GroupedList title={t("people.project.nextStep")}>
              <CurrentFact
                entity={e}
                attribute="next_step"
                now={now}
                busy={busy}
                {...(actions.onSetFact ? { onSet: actions.onSetFact } : {})}
                {...(actions.onRetractFact ? { onRetract: actions.onRetractFact } : {})}
              />
            </GroupedList>
            {assignment && names.length > 0 ? (
              <GroupedList title={t("work.section.details")}>
                {e.parent ? (
                  <EdgeRow
                    edge={{
                      id: `${e.id}-parent`,
                      rel: "part_of",
                      provenance: "owner",
                      other: e.parent,
                    }}
                    {...(actions.onOpenEntity ? { onOpenEntity: actions.onOpenEntity } : {})}
                  />
                ) : null}
                {e.assignedBy ? (
                  <EdgeRow
                    edge={{
                      id: `${e.id}-assigner`,
                      rel: "assigned_by",
                      provenance: "owner",
                      other: e.assignedBy,
                    }}
                    {...(actions.onOpenEntity ? { onOpenEntity: actions.onOpenEntity } : {})}
                  />
                ) : null}
              </GroupedList>
            ) : null}
            {!assignment ? (
              <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2 px-1">
                  <h3 className="text-title-3 text-label-primary">{t("work.section.work")}</h3>
                  {addAssignment && !adding ? (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(true)}>
                      <Plus aria-hidden="true" />
                      {t("work.add.button")}
                    </Button>
                  ) : null}
                </div>
                {adding && addAssignment ? addAssignment(() => setAdding(false)) : null}
                <div className="flex flex-col rounded-lg bg-surface-raised shadow-elevation-1">
                  {assignments.length === 0 ? (
                    <EmptyRow>{t("work.empty.assignments")}</EmptyRow>
                  ) : (
                    assignments.map((a) => (
                      <WorkRow
                        key={a.id}
                        item={a}
                        now={now}
                        hideParent
                        {...(busy ? { busy } : {})}
                        onOpen={(id) => actions.onOpenEntity?.(id)}
                        {...(actions.onSetWorkStatus
                          ? {
                              onSetStatus: (item, status) => {
                                const target = { ...e, id: item.id, name: item.name };
                                actions.onSetWorkStatus?.(target, status);
                              },
                            }
                          : {})}
                      />
                    ))
                  )}
                </div>
              </section>
            ) : null}
            {!assignment ? (
              <section className="flex flex-col gap-2">
                <h3 className="px-1 text-title-3 text-label-primary">{t("work.section.people")}</h3>
                {members.length === 0 ? (
                  <p className="px-1 text-body text-label-secondary">{t("people.empty.members")}</p>
                ) : (
                  <ul className="flex flex-wrap gap-1.5">
                    {members.map((edge) => (
                      <li key={edge.id}>
                        <button
                          type="button"
                          disabled={!actions.onOpenEntity}
                          onClick={() => actions.onOpenEntity?.(edge.other.id)}
                          className="flex h-7 items-center gap-1.5 rounded-full bg-fill-tertiary ps-1 pe-2.5 text-body text-label-primary outline-none transition-colors duration-(--duration-micro) hover:bg-fill-secondary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                        >
                          <EntityMonogram kind={edge.other.kind} name={edge.other.name} />
                          {edge.other.name}
                          <span className="text-callout text-label-secondary">
                            · {edge.label ?? t(`people.rel.${edge.rel}`)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : null}
            <GroupedList title={t("people.section.loops")}>
              <LoopRows entity={e} now={now} actions={actions} busy={busy} />
            </GroupedList>
            <GroupedList title={t("people.section.timeline")}>
              {timeline ?? <EmptyRow>{t("work.timeline.empty")}</EmptyRow>}
            </GroupedList>
            {history ? (
              <GroupedList title={t("work.section.history")}>{history}</GroupedList>
            ) : null}
            <GroupedList title={t("work.section.linked")}>
              {linked ?? <EmptyRow>{t("work.anchors.empty")}</EmptyRow>}
            </GroupedList>
            <GroupedList title={t("people.section.facts")}>
              <FactRows
                entity={e}
                facts={otherFacts}
                actions={actions}
                persona={persona}
                busy={busy}
              />
            </GroupedList>
            <GroupedList title={t("people.section.notes")}>
              <NotesEditor
                entity={e}
                busy={busy}
                {...(actions.onSaveNotes ? { onSave: actions.onSaveNotes } : {})}
              />
            </GroupedList>
          </>
        );
      }}
    </CardFrame>
  );
}
