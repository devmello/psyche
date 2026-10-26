import { Ellipsis, ExternalLink } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useId, useState } from "react";
import { ErrorState, GroupedList, LoadingCards, useDelayedFlag } from "../components/page.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { t } from "../i18n/core.ts";
import { formatDate } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { SegmentedRadio } from "../screens/settings/SegmentedRadio.tsx";
import { AddFactRow, FactRow } from "./FactRow.tsx";
import { EntityMonogram, INTERACTION_ICON } from "./glyphs.tsx";
import { LoopRow } from "./LoopRow.tsx";
import type {
  GraphEdge,
  GraphEntity,
  GraphFact,
  GraphFactAttribute,
  GraphInteraction,
  GraphLoop,
  GraphLoopStatus,
  ProjectStatus,
} from "./types.ts";

/** Everything a card can ask its host to do; each is optional, and a missing one hides its control. */
export interface EntityCardActions {
  onSetFact?: (entity: GraphEntity, attribute: GraphFactAttribute, value: string) => void;
  onRetractFact?: (entity: GraphEntity, fact: GraphFact) => void;
  onUpdateLoop?: (entity: GraphEntity, loop: GraphLoop, status: GraphLoopStatus) => void;
  onSaveNotes?: (entity: GraphEntity, notes: string) => void;
  onSetStatus?: (entity: GraphEntity, status: ProjectStatus) => void;
  onTogglePin?: (entity: GraphEntity) => void;
  onMerge?: (entity: GraphEntity) => void;
  onForget?: (entity: GraphEntity) => void;
  /** Opens another person, org or project's card. */
  onOpenEntity?: (id: string) => void;
  /** Opens a link back to Mail, Calendar or Messages. */
  onOpenLink?: (link: string) => void;
}

export interface EntityCardProps extends EntityCardActions {
  entity: GraphEntity | null;
  now: number;
  /** Persona name, for the empty-facts hint. */
  persona?: string;
  loading?: boolean;
  loadingDelayMs?: number;
  error?: string | null;
  onRetry?: () => void;
  /** Recent interactions shown (the preview pane shows fewer). */
  recentLimit?: number;
  /** A write is in flight. */
  busy?: boolean;
  className?: string;
}

/** "Person · Acme", "Project · Active". */
export function kindLine(entity: GraphEntity): string {
  const kind = t(`people.kind.${entity.kind}`);
  let detail: string | null = null;
  if (entity.kind === "project" && entity.projectStatus)
    detail = t(`people.project.status.${entity.projectStatus}`);
  else if (entity.kind === "person") {
    detail =
      entity.edges.find((e) => e.rel === "works_at")?.other.name ??
      entity.facts.find((f) => f.attribute === "employer" && f.provenance !== "untrusted")?.value ??
      null;
  }
  return detail ? t("people.kindLine", { kind, detail }) : kind;
}

function CardHeader({
  entity,
  actions,
}: {
  entity: GraphEntity;
  actions: EntityCardActions;
}): ReactElement {
  const hasMenu = actions.onTogglePin || actions.onMerge || actions.onForget;
  return (
    <header className="flex items-start gap-3">
      <EntityMonogram kind={entity.kind} name={entity.name} size={40} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="text-title-2 text-label-primary">{entity.name}</h2>
        <p className="text-caption text-label-secondary">{kindLine(entity)}</p>
      </div>
      {hasMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t("people.more", { name: entity.name })}
                className="text-label-secondary"
              />
            }
          >
            <Ellipsis aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {actions.onTogglePin ? (
              <DropdownMenuItem onClick={() => actions.onTogglePin?.(entity)}>
                {entity.pinned ? t("people.unpin") : t("people.pin")}
              </DropdownMenuItem>
            ) : null}
            {actions.onMerge ? (
              <DropdownMenuItem onClick={() => actions.onMerge?.(entity)}>
                {t("people.merge")}
              </DropdownMenuItem>
            ) : null}
            {actions.onForget ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => actions.onForget?.(entity)}>
                  {t("people.forget")}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </header>
  );
}

function Summary({ entity }: { entity: GraphEntity }): ReactElement | null {
  if (!entity.summary) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-reading text-label-primary">{entity.summary}</p>
      {entity.summaryAt ? (
        <p className="text-callout text-label-tertiary">
          {t("people.summary.asOf", { date: formatDate(entity.summaryAt) })}
        </p>
      ) : null}
    </div>
  );
}

function EmptyRow({ children }: { children: ReactNode }): ReactElement {
  return <p className="px-3 py-2 text-body text-label-secondary">{children}</p>;
}

/** Interaction rows, newest first, each linking back to its app (spec §6.5 "Recent"). */
function RecentRows({
  interactions,
  limit,
  onOpenLink,
}: {
  interactions: readonly GraphInteraction[];
  limit: number;
  onOpenLink?: (link: string) => void;
}): ReactElement {
  if (interactions.length === 0) return <EmptyRow>{t("people.empty.recent")}</EmptyRow>;
  const rows = [...interactions]
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
    .slice(0, limit);
  return (
    <>
      {rows.map((it) => {
        const Icon = INTERACTION_ICON[it.kind];
        const app = t(`people.app.${it.kind}`);
        const link = it.link ?? null;
        return (
          <div
            key={it.id}
            className="relative flex min-h-9 items-center gap-3 px-3 py-1.5 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator first:before:hidden"
          >
            <Icon className="size-4 shrink-0 text-label-secondary" aria-hidden="true" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-body text-label-primary">{it.subject}</span>
              <span className="text-callout text-label-secondary">
                {t(`people.recent.${it.direction}`)} · {app} · {formatDate(it.occurredAt)}
              </span>
            </div>
            {link && onOpenLink ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="shrink-0 text-label-secondary"
                aria-label={t("people.recent.open", { app })}
                title={t("people.recent.open", { app })}
                onClick={() => onOpenLink(link)}
              >
                <ExternalLink aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/** The owner's Notes section, verbatim (spec §4.8: Psyche never rewrites it). */
function NotesEditor({
  entity,
  onSave,
  busy,
}: {
  entity: GraphEntity;
  onSave?: (entity: GraphEntity, notes: string) => void;
  busy: boolean;
}): ReactElement {
  const id = useId();
  const [draft, setDraft] = useState(entity.notes ?? "");
  useEffect(() => setDraft(entity.notes ?? ""), [entity.notes]);
  const changed = draft !== (entity.notes ?? "");
  return (
    <div className="flex flex-col gap-2 p-3">
      <label htmlFor={id} className="sr-only">
        {t("people.section.notes")}
      </label>
      <Textarea
        id={id}
        value={draft}
        readOnly={!onSave}
        placeholder={t("people.notes.placeholder")}
        onChange={(e) => setDraft(e.target.value)}
        className="min-h-20 text-body"
      />
      {onSave && changed ? (
        <div className="flex justify-end">
          <Button type="button" size="sm" disabled={busy} onClick={() => onSave(entity, draft)}>
            {t("people.notes.save")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FactRows({
  entity,
  facts,
  actions,
  persona,
  busy,
}: {
  entity: GraphEntity;
  facts: readonly GraphFact[];
  actions: EntityCardActions;
  persona: string;
  busy: boolean;
}): ReactElement {
  const sorted = [...facts].sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
  return (
    <>
      {sorted.length === 0 ? (
        <EmptyRow>{t("people.empty.facts", { persona })}</EmptyRow>
      ) : (
        sorted.map((fact) => (
          <FactRow
            key={fact.id}
            fact={fact}
            busy={busy}
            {...(actions.onSetFact
              ? {
                  onSet: (f: GraphFact, value: string) =>
                    actions.onSetFact?.(entity, f.attribute, value),
                }
              : {})}
            {...(actions.onRetractFact
              ? { onRetract: (f: GraphFact) => actions.onRetractFact?.(entity, f) }
              : {})}
          />
        ))
      )}
      {actions.onSetFact ? (
        <AddFactRow
          kind={entity.kind}
          busy={busy}
          onAdd={(attribute, value) => actions.onSetFact?.(entity, attribute, value)}
        />
      ) : null}
    </>
  );
}

function LoopRows({
  entity,
  now,
  actions,
  busy,
}: {
  entity: GraphEntity;
  now: number;
  actions: EntityCardActions;
  busy: boolean;
}): ReactElement {
  const shown = entity.loops.filter((l) => l.status !== "dismissed");
  if (shown.length === 0) return <EmptyRow>{t("people.empty.loops")}</EmptyRow>;
  // Open first (overdue and soonest due on top), then suggestions, then done.
  const rank = (l: GraphLoop) => (l.status === "open" ? 0 : l.status === "suggested" ? 1 : 2);
  const sorted = [...shown].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY) -
        (b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY),
  );
  return (
    <>
      {sorted.map((loop) => (
        <LoopRow
          key={loop.id}
          loop={loop}
          now={now}
          busy={busy}
          hideCounterpart={loop.counterpart?.id === entity.id}
          {...(actions.onUpdateLoop
            ? {
                onUpdate: (l: GraphLoop, s: GraphLoopStatus) =>
                  actions.onUpdateLoop?.(entity, l, s),
              }
            : {})}
          {...(actions.onOpenLink ? { onOpenLink: actions.onOpenLink } : {})}
        />
      ))}
    </>
  );
}

/** A related project, org or person as a row that opens its card. */
function EdgeRow({
  edge,
  onOpenEntity,
}: {
  edge: GraphEdge;
  onOpenEntity?: (id: string) => void;
}): ReactElement {
  const content = (
    <>
      <EntityMonogram kind={edge.other.kind} name={edge.other.name} />
      <span className="min-w-0 flex-1 truncate text-body text-label-primary">
        {edge.other.name}
      </span>
      <span className="text-callout text-label-secondary">
        {edge.label ?? t(`people.rel.${edge.rel}`)}
      </span>
    </>
  );
  const row =
    "relative flex min-h-9 w-full items-center gap-3 px-3 py-1.5 text-start before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator first:before:hidden";
  return onOpenEntity ? (
    <button
      type="button"
      className={cn(
        row,
        "outline-none transition-colors duration-(--duration-micro) hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring",
      )}
      onClick={() => onOpenEntity(edge.other.id)}
    >
      {content}
    </button>
  ) : (
    <div className={row}>{content}</div>
  );
}

function CardFrame({
  entity,
  loading,
  loadingDelayMs,
  error,
  onRetry,
  className,
  children,
}: {
  entity: GraphEntity | null;
  loading: boolean;
  loadingDelayMs: number;
  error: string | null;
  onRetry?: () => void;
  className?: string;
  children: (entity: GraphEntity) => ReactNode;
}): ReactElement {
  const showSkeleton = useDelayedFlag(loading && entity === null, loadingDelayMs);
  if (entity === null) {
    if (error !== null)
      return (
        <ErrorState
          what={t("people.error")}
          reason={error}
          did={t("people.errorDid")}
          {...(onRetry ? { retry: { onClick: onRetry } } : {})}
        />
      );
    return showSkeleton ? (
      <LoadingCards label={t("people.loading")} count={1} lines={6} />
    ) : (
      <div aria-busy="true" className="min-h-24" />
    );
  }
  return (
    <article
      aria-label={entity.name}
      className={cn(
        "flex flex-col gap-5 rounded-lg bg-surface-raised p-4 shadow-elevation-1",
        className,
      )}
    >
      {children(entity)}
    </article>
  );
}

/**
 * A person's card (spec §6.5): header, summary, then grouped rows for Facts, Open loops,
 * Projects, Recent and Notes. Facts carry their provenance and source; untrusted claims read as
 * the sender's words. Every write goes through the host's callbacks.
 */
export function PersonCard({
  entity,
  now,
  persona = "Wren",
  loading = false,
  loadingDelayMs = 0,
  error = null,
  onRetry,
  recentLimit = 5,
  busy = false,
  className,
  ...actions
}: EntityCardProps): ReactElement {
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
        const projects = e.edges.filter((edge) => edge.other.kind === "project");
        const others = e.edges.filter((edge) => edge.other.kind !== "project");
        return (
          <>
            <CardHeader entity={e} actions={actions} />
            <Summary entity={e} />
            <GroupedList title={t("people.section.facts")}>
              <FactRows
                entity={e}
                facts={e.facts}
                actions={actions}
                persona={persona}
                busy={busy}
              />
              {others.map((edge) => (
                <EdgeRow
                  key={edge.id}
                  edge={edge}
                  {...(actions.onOpenEntity ? { onOpenEntity: actions.onOpenEntity } : {})}
                />
              ))}
            </GroupedList>
            <GroupedList title={t("people.section.loops")}>
              <LoopRows entity={e} now={now} actions={actions} busy={busy} />
            </GroupedList>
            <GroupedList title={t("people.section.projects")}>
              {projects.length === 0 ? (
                <EmptyRow>{t("people.empty.projects")}</EmptyRow>
              ) : (
                projects.map((edge) => (
                  <EdgeRow
                    key={edge.id}
                    edge={edge}
                    {...(actions.onOpenEntity ? { onOpenEntity: actions.onOpenEntity } : {})}
                  />
                ))
              )}
            </GroupedList>
            <GroupedList title={t("people.section.recent")}>
              <RecentRows
                interactions={e.interactions}
                limit={recentLimit}
                {...(actions.onOpenLink ? { onOpenLink: actions.onOpenLink } : {})}
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

const PROJECT_STATUSES: readonly ProjectStatus[] = ["active", "paused", "done"];

/**
 * A project's card (spec §6.5): a status segmented control (Active / Paused / Done), the next
 * step, members as chips, open loops, the timeline and the remaining facts.
 */
export function ProjectCard({
  entity,
  now,
  persona = "Wren",
  loading = false,
  loadingDelayMs = 0,
  error = null,
  onRetry,
  recentLimit = 5,
  busy = false,
  className,
  ...actions
}: EntityCardProps): ReactElement {
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
        const nextStep = e.facts.find((f) => f.attribute === "next_step");
        const otherFacts = e.facts.filter((f) => f.attribute !== "next_step");
        const members = e.edges.filter((edge) => edge.other.kind !== "project");
        return (
          <>
            <CardHeader entity={e} actions={actions} />
            <Summary entity={e} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-body text-label-secondary">{t("people.project.status")}</span>
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
            </div>
            <GroupedList title={t("people.project.nextStep")}>
              {nextStep ? (
                <FactRow
                  fact={nextStep}
                  busy={busy}
                  {...(actions.onSetFact
                    ? { onSet: (f: GraphFact, v: string) => actions.onSetFact?.(e, f.attribute, v) }
                    : {})}
                  {...(actions.onRetractFact
                    ? { onRetract: (f: GraphFact) => actions.onRetractFact?.(e, f) }
                    : {})}
                />
              ) : (
                <EmptyRow>{t("people.project.noNextStep")}</EmptyRow>
              )}
            </GroupedList>
            <section className="flex flex-col gap-2">
              <h3 className="px-1 text-title-3 text-label-primary">
                {t("people.section.members")}
              </h3>
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
            <GroupedList title={t("people.section.loops")}>
              <LoopRows entity={e} now={now} actions={actions} busy={busy} />
            </GroupedList>
            <GroupedList title={t("people.section.timeline")}>
              <RecentRows
                interactions={e.interactions}
                limit={recentLimit}
                {...(actions.onOpenLink ? { onOpenLink: actions.onOpenLink } : {})}
              />
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

/** The right card for the entity's kind (orgs and places use the person layout). */
export function EntityCard(props: EntityCardProps): ReactElement {
  return props.entity?.kind === "project" ? <ProjectCard {...props} /> : <PersonCard {...props} />;
}
