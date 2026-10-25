import type { Artifact, Goal, GoalMilestone, Task } from "@psyche/protocol";
import { Ellipsis, FileText, Trash2 } from "lucide-react";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { Markdown } from "../../blocks/Markdown.tsx";
import { TASK_STATUS_LABEL } from "../../blocks/TaskCard.tsx";
import {
  ErrorState,
  GroupedList,
  GroupedRow,
  LoadingCards,
  useDelayedFlag,
} from "../../components/page.tsx";
import { StatusGlyph, type StatusKind } from "../../components/status.tsx";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { useArtifact, useCall, useGoal, useTask } from "../../data/hooks.ts";
import { activeI18n, t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { formatDate, formatTime } from "../../lib/format.ts";
import { cn } from "../../lib/utils.ts";
import { useSlots } from "../../slots.tsx";
import {
  GOAL_CATEGORY_LABEL,
  type GoalMilestoneView,
  type GoalPlan,
  readGoalPlan,
} from "./goal-plan.ts";
import { MilestoneTrack } from "./MilestoneTrack.tsx";

/** "Mon 08:00" in UTC, like the rest of the kit's times. */
export function formatWhen(iso: string): string {
  const day = activeI18n().date(iso, { weekday: "short", timeZone: "UTC" });
  return `${day} ${formatTime(iso)}`;
}

/** Milestones from `goals.get` when the Gateway sends them, else the `goal.plan` convention. */
export function goalMilestones(
  plan: GoalPlan,
  fromGateway: readonly GoalMilestone[] | null,
): GoalMilestoneView[] {
  if (fromGateway === null) return plan.milestones;
  return fromGateway.map((m) => ({ title: m.title, done: m.doneAt !== null, dueAt: m.dueAt }));
}

const confirmWord = () => t("screens.goals.confirmWord");

export interface DeleteGoalDialogProps {
  goal: Goal;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (goal: Goal) => void;
}

/** Delete needs a typed confirmation (UI design §3.11). */
export function DeleteGoalDialog({
  goal,
  open,
  onOpenChange,
  onConfirm,
}: DeleteGoalDialogProps): ReactElement {
  const inputId = useId();
  const [typed, setTyped] = useState("");
  const ok = typed.trim().toLowerCase() === confirmWord().toLowerCase();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped("");
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("screens.goals.deleteTitle", { title: goal.title })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t("screens.goals.deleteBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) onConfirm(goal);
          }}
        >
          <Label htmlFor={inputId}>
            {t("screens.goals.typeToConfirm", { word: confirmWord() })}
          </Label>
          <Input
            id={inputId}
            value={typed}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
          />
          <AlertDialogFooter className="mt-2">
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <Button type="submit" variant="destructive" disabled={!ok}>
              {t("screens.goals.delete")}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** One group of the goal page: a text-title-3 header over a raised, borderless group (§5.8). */
function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return <GroupedList title={title}>{children}</GroupedList>;
}

/** A plain line inside a group, for empty and single-value content. */
function Line({ children }: { children: ReactNode }): ReactElement {
  return <GroupedRow label={children} />;
}

const TASK_GLYPH: Record<Task["status"], StatusKind> = {
  queued: "pending",
  running: "running",
  awaiting_input: "waiting",
  awaiting_approval: "waiting",
  paused: "paused",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

export interface GoalTaskRowProps {
  taskId: string;
  onOpen?: (taskId: string) => void;
}

/** One linked task, loaded by id (`useTask`). */
export function GoalTaskRow({ taskId, onOpen }: GoalTaskRowProps): ReactElement {
  const { task } = useTask(taskId);
  return <TaskLine task={task} taskId={taskId} {...(onOpen ? { onOpen } : {})} />;
}

function TaskLine({
  task,
  taskId,
  onOpen,
}: {
  task: Task | null;
  taskId: string;
  onOpen?: (taskId: string) => void;
}): ReactElement {
  if (task === null) return <Line>{t("screens.goals.loadingTask")}</Line>;
  return (
    <GroupedRow
      leading={<StatusGlyph status={TASK_GLYPH[task.status]} />}
      label={
        onOpen ? (
          <button
            type="button"
            className="min-w-0 truncate text-start underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => onOpen(taskId)}
          >
            {task.title}
          </button>
        ) : (
          <span className="min-w-0 truncate">{task.title}</span>
        )
      }
      control={
        <span className="text-callout text-label-secondary">{TASK_STATUS_LABEL[task.status]}</span>
      }
    />
  );
}

/** The plan artifact as a file tile; it is a button only when it can be opened. */
function PlanTile({
  artifact,
  onOpen,
}: {
  artifact: Artifact;
  onOpen?: (artifact: Artifact) => void;
}): ReactElement {
  const inner = (
    <>
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-fill-secondary text-label-secondary"
      >
        <FileText className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-body text-label-primary">{artifact.title}</span>
        <span className="text-callout text-label-secondary">
          {t("screens.goals.planMeta", {
            type: artifact.type.toUpperCase(),
            version: artifact.version,
            open: Boolean(onOpen),
          })}
        </span>
      </span>
    </>
  );
  const cls = "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start";
  return onOpen ? (
    <button
      type="button"
      onClick={() => onOpen(artifact)}
      className={cn(
        cls,
        "transition-colors hover:bg-fill-quaternary focus-visible:outline-2 focus-visible:outline-ring",
      )}
    >
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

export interface GoalPageViewProps {
  goal: Goal | null;
  /** Milestones from `goals.get`, or null to read the `goal.plan` convention. */
  milestones?: readonly GoalMilestone[] | null;
  /** The plan artifact, when it is loaded. */
  planArtifact?: Artifact | null;
  taskIds?: readonly string[];
  /** Renders each linked task; defaults to `GoalTaskRow` (needs the Gateway). */
  renderTask?: (taskId: string) => ReactNode;
  loading?: boolean;
  loadingDelayMs?: number;
  error?: string | null;
  onRetry?: () => void;
  onOpenArtifact?: (artifact: Artifact) => void;
  onOpenTask?: (taskId: string) => void;
  onDelete?: (goal: Goal) => void;
}

/** Goal page (UI design §3.11, a Psyche decision): milestones, plan, tasks, check-ins, watches, notes. */
export function GoalPageView({
  goal,
  milestones = null,
  planArtifact = null,
  taskIds = [],
  renderTask,
  loading = false,
  loadingDelayMs = 0,
  error = null,
  onRetry,
  onOpenArtifact,
  onOpenTask,
  onDelete,
}: GoalPageViewProps): ReactElement {
  const titleId = useId();
  const [confirming, setConfirming] = useState(false);
  const showSkeleton = useDelayedFlag(loading && goal === null, loadingDelayMs);

  if (goal === null) {
    if (error !== null)
      return (
        <ErrorState
          what={t("screens.goals.loadFailed")}
          reason={error}
          {...(onRetry ? { retry: { onClick: onRetry } } : {})}
        />
      );
    return showSkeleton ? (
      <LoadingCards label={t("screens.goals.loading")} count={1} lines={6} />
    ) : (
      <div aria-busy="true" className="min-h-24" />
    );
  }

  const plan = readGoalPlan(goal);
  const items = goalMilestones(plan, milestones);
  const lastCheckin = plan.checkins[0];

  return (
    <article aria-labelledby={titleId} className="flex flex-col gap-6">
      <header className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-callout text-label-secondary">
            {t("screens.goals.categoryStatus", {
              category: GOAL_CATEGORY_LABEL[goal.category],
              status: goal.status,
              inactive: goal.status !== "active",
            })}
          </p>
          <h2 id={titleId} className="text-title-1 text-label-primary">
            {goal.title}
          </h2>
        </div>
        {onDelete ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("screens.goals.moreFor", { title: goal.title })}
                />
              }
            >
              <Ellipsis aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
                <Trash2 aria-hidden="true" />
                {t("screens.goals.deleteMenu")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </header>

      <Section title={t("screens.goals.milestones")}>
        {items.length === 0 ? (
          <Line>{t("screens.goals.noMilestones")}</Line>
        ) : (
          <MilestoneTrack milestones={items} className="px-3 pt-4 pb-3" />
        )}
      </Section>

      <Section title={t("screens.goals.plan")}>
        {plan.planArtifactId === null ? (
          <Line>{t("screens.goals.noPlan")}</Line>
        ) : planArtifact === null ? (
          <Line>{t("screens.goals.loadingPlan")}</Line>
        ) : (
          <PlanTile
            artifact={planArtifact}
            {...(onOpenArtifact ? { onOpen: onOpenArtifact } : {})}
          />
        )}
      </Section>

      <Section title={t("screens.goals.tasks")}>
        {taskIds.length === 0 ? (
          <Line>{t("screens.goals.noTasks")}</Line>
        ) : (
          taskIds.map((id) => (
            <div key={id} className="contents">
              {renderTask ? (
                <GroupedRow label={renderTask(id)} />
              ) : (
                <GoalTaskRow taskId={id} {...(onOpenTask ? { onOpen: onOpenTask } : {})} />
              )}
            </div>
          ))
        )}
      </Section>

      <Section title={t("screens.goals.checkins")}>
        <Line>
          {t("screens.goals.checkinLine", {
            cadence: goal.cadence ? goal.cadence : t("screens.goals.noSchedule"),
            next: goal.nextCheckinAt ? formatWhen(goal.nextCheckinAt) : "",
            hasNext: Boolean(goal.nextCheckinAt),
            last: lastCheckin?.status ?? "",
            hasLast: Boolean(lastCheckin),
          })}
        </Line>
        {plan.checkins.map((c) => (
          <GroupedRow
            key={c.at}
            label={c.status}
            {...(c.note ? { description: c.note } : {})}
            control={
              <span className="text-callout text-label-secondary tabular-nums">
                {formatDate(c.at)}
              </span>
            }
          />
        ))}
      </Section>

      <Section title={t("screens.goals.watches")}>
        {plan.watches.length === 0 ? (
          <Line>{t("screens.goals.nothingWatched")}</Line>
        ) : (
          plan.watches.map((w) => (
            <GroupedRow
              key={w.title}
              label={
                w.url ? (
                  <a
                    href={w.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-accent-11 underline-offset-2 hover:underline"
                  >
                    {w.title}
                  </a>
                ) : (
                  w.title
                )
              }
              {...(w.lastValue
                ? { description: t("screens.goals.last", { value: w.lastValue }) }
                : {})}
              {...(w.condition ? { control: <Badge variant="muted">{w.condition}</Badge> } : {})}
            />
          ))
        )}
      </Section>

      <Section title={t("screens.goals.notes")}>
        {plan.notesMd.trim() === "" ? (
          <Line>{t("screens.goals.noNotes")}</Line>
        ) : (
          <Markdown className="px-3 py-2.5 text-reading text-label-primary">
            {plan.notesMd}
          </Markdown>
        )}
      </Section>

      {onDelete ? (
        <DeleteGoalDialog
          goal={goal}
          open={confirming}
          onOpenChange={setConfirming}
          onConfirm={(g) => {
            setConfirming(false);
            onDelete(g);
          }}
        />
      ) : null}
    </article>
  );
}

export interface GoalPageProps {
  goalId: string;
  /**
   * Deletes the goal. Defaults to `goals.archive` (the protocol has no hard delete); the shell
   * should navigate away afterwards.
   */
  onDelete?: (goal: Goal) => Promise<unknown> | undefined;
  /** Called after a successful delete, e.g. to return to `/goals`. */
  onDeleted?: (goal: Goal) => void;
}

/** Connected goal page: `goals.get` (goal, task ids, milestones), `artifacts.get`, `tasks.get`. */
export function GoalPage({ goalId, onDelete, onDeleted }: GoalPageProps): ReactElement {
  const { navigate, openArtifact } = useSlots();
  const call = useCall();
  const g = useGoal(goalId);
  const planId = g.goal === null ? null : readGoalPlan(g.goal).planArtifactId;
  const { artifact } = useArtifact(planId);

  const remove = (goal: Goal) => {
    const run = onDelete ?? ((x: Goal) => call("goals.archive", { goalId: x.id }));
    Promise.resolve(run(goal)).then(
      () => {
        toast(t("screens.goals.deleted", { title: goal.title }));
        onDeleted?.(goal);
      },
      (err: unknown) => {
        toast.error(
          t("screens.goals.deleteFailed", { title: goal.title, reason: describeError(err) }),
        );
      },
    );
  };

  return (
    <GoalPageView
      goal={g.goal}
      milestones={g.milestones}
      planArtifact={artifact}
      taskIds={g.taskIds}
      loading={g.loading}
      loadingDelayMs={150}
      error={g.error}
      onRetry={g.reload}
      onOpenTask={(id) => navigate?.(`/agent/activity/${id}`)}
      onDelete={remove}
      {...(openArtifact ? { onOpenArtifact: openArtifact } : {})}
    />
  );
}
