import type { Artifact, Goal, GoalMilestone, Task } from "@psyche/protocol";
import { Circle, CircleCheck, Ellipsis, FileText, Trash2 } from "lucide-react";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { Markdown } from "../../blocks/Markdown.tsx";
import { TASK_STATUS_LABEL, TaskStatusIcon } from "../../blocks/TaskCard.tsx";
import { ErrorState, LoadingCards, SectionLabel, useDelayedFlag } from "../../components/page.tsx";
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
import { Progress } from "../../components/ui/progress.tsx";
import { useArtifact, useCall, useGoal, useTask } from "../../data/hooks.ts";
import { formatDate, formatTime } from "../../lib/format.ts";
import { cn } from "../../lib/utils.ts";
import { useSlots } from "../../slots.tsx";
import {
  GOAL_CATEGORY_LABEL,
  type GoalMilestoneView,
  type GoalPlan,
  readGoalPlan,
} from "./goal-plan.ts";

/** "Mon 08:00" in UTC, like the rest of the kit's times. */
export function formatWhen(iso: string): string {
  const day = new Date(iso).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
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

const CONFIRM_WORD = "delete";

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
  const ok = typed.trim().toLowerCase() === CONFIRM_WORD;
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
          <AlertDialogTitle>Delete "{goal.title}"?</AlertDialogTitle>
          <AlertDialogDescription>
            Check-ins stop and the goal leaves your list. Linked tasks and the plan stay in Activity
            and Library.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) onConfirm(goal);
          }}
        >
          <Label htmlFor={inputId}>Type "{CONFIRM_WORD}" to confirm</Label>
          <Input
            id={inputId}
            value={typed}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
          />
          <AlertDialogFooter className="mt-2">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button type="submit" variant="destructive" disabled={!ok}>
              Delete goal
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="grid gap-2 border-t border-gray-6 py-4 sm:grid-cols-[8rem_1fr] sm:gap-4">
      <SectionLabel as="h3" className="sm:pt-0.5">
        {title}
      </SectionLabel>
      <div className="min-w-0 text-small text-gray-12">{children}</div>
    </section>
  );
}

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
  if (task === null) return <span className="text-gray-11">Loading task…</span>;
  return (
    <span className="flex items-center gap-2">
      <TaskStatusIcon status={task.status} />
      {onOpen ? (
        <button
          type="button"
          className="min-w-0 truncate text-left underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => onOpen(taskId)}
        >
          {task.title}
        </button>
      ) : (
        <span className="min-w-0 truncate">{task.title}</span>
      )}
      <span className="text-caption text-gray-11">{TASK_STATUS_LABEL[task.status]}</span>
    </span>
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
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-3 text-accent-11"
      >
        <FileText className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-foreground">{artifact.title}</span>
        <span className="text-caption text-gray-11">
          {artifact.type.toUpperCase()} · v{artifact.version}
          {onOpen ? " · Open" : ""}
        </span>
      </span>
    </>
  );
  const cls =
    "inline-flex max-w-full items-center gap-3 rounded-lg border border-gray-6 bg-gray-1 py-2 pr-4 pl-2 text-left";
  return onOpen ? (
    <button
      type="button"
      onClick={() => onOpen(artifact)}
      className={cn(
        cls,
        "transition-colors hover:border-gray-8 hover:bg-gray-3 focus-visible:outline-2 focus-visible:outline-ring",
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
          what="Psyche couldn't load this goal"
          reason={error}
          {...(onRetry ? { retry: { onClick: onRetry } } : {})}
        />
      );
    return showSkeleton ? (
      <LoadingCards label="Loading the goal" count={1} lines={6} />
    ) : (
      <div aria-busy="true" className="min-h-24" />
    );
  }

  const plan = readGoalPlan(goal);
  const items = goalMilestones(plan, milestones);
  const lastCheckin = plan.checkins[0];
  const doneCount = items.filter((m) => m.done).length;
  const nextIndex = items.findIndex((m) => !m.done);

  return (
    <article aria-labelledby={titleId} className="flex flex-col">
      <header className="flex items-start gap-2 pb-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <SectionLabel as="p">
            {GOAL_CATEGORY_LABEL[goal.category]}
            {goal.status !== "active" ? ` · ${goal.status}` : ""}
          </SectionLabel>
          <h2 id={titleId} className="text-h2 text-foreground">
            {goal.title}
          </h2>
          {items.length > 0 ? (
            <div className="mt-2 flex items-center gap-3">
              <Progress
                value={(doneCount / items.length) * 100}
                aria-label={`${doneCount} of ${items.length} milestones done`}
                className={cn(
                  "max-w-64 flex-1 [&_[data-slot=progress-track]]:h-1.5",
                  doneCount === items.length ? "[&_[data-slot=progress-indicator]]:bg-grass-9" : "",
                )}
              />
              <span className="text-caption text-gray-11 tabular-nums">
                {doneCount} of {items.length} milestones
              </span>
            </div>
          ) : null}
        </div>
        {onDelete ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`More actions for ${goal.title}`}
                />
              }
            >
              <Ellipsis aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
                <Trash2 aria-hidden="true" />
                Delete goal…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </header>

      <Section title="Milestones">
        {items.length === 0 ? (
          <p className="text-gray-11">No milestones yet.</p>
        ) : (
          <ol className="flex flex-wrap items-center gap-1.5">
            {items.map((m, i) => (
              <li key={m.title} className="flex items-center gap-1.5">
                {i > 0 ? (
                  <span
                    aria-hidden="true"
                    className={cn("h-px w-3", m.done ? "bg-grass-8" : "bg-gray-6")}
                  />
                ) : null}
                <span
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5",
                    m.done
                      ? "border-transparent bg-grass-3 text-grass-11"
                      : i === nextIndex
                        ? "border-accent-7 bg-gray-1 text-foreground"
                        : "border-gray-6 text-gray-11",
                  )}
                >
                  {m.done ? (
                    <CircleCheck className="size-3.5" aria-hidden="true" />
                  ) : (
                    <Circle className="size-3.5" aria-hidden="true" />
                  )}
                  <span>{m.title}</span>
                  <span className="sr-only">{m.done ? "(done)" : "(not done)"}</span>
                  {m.dueAt ? (
                    <span className="text-caption opacity-80">· {formatDate(m.dueAt)}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section title="Plan">
        {plan.planArtifactId === null ? (
          <p className="text-gray-11">No plan yet. Ask in chat for one.</p>
        ) : planArtifact === null ? (
          <p className="text-gray-11">Loading the plan…</p>
        ) : (
          <PlanTile
            artifact={planArtifact}
            {...(onOpenArtifact ? { onOpen: onOpenArtifact } : {})}
          />
        )}
      </Section>

      <Section title="Tasks">
        {taskIds.length === 0 ? (
          <p className="text-gray-11">No linked tasks.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {taskIds.map((id) => (
              <li key={id}>
                {renderTask ? (
                  renderTask(id)
                ) : (
                  <GoalTaskRow taskId={id} {...(onOpenTask ? { onOpen: onOpenTask } : {})} />
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Check-ins">
        <p>
          {goal.cadence ? goal.cadence : "No schedule"}
          {goal.nextCheckinAt ? ` · next ${formatWhen(goal.nextCheckinAt)}` : ""}
          {lastCheckin ? ` · last: ${lastCheckin.status}` : ""}
        </p>
        {plan.checkins.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-0.5 text-gray-11">
            {plan.checkins.map((c) => (
              <li key={c.at}>
                <span className="tabular-nums">{formatDate(c.at)}</span> · {c.status}
                {c.note ? ` · ${c.note}` : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section title="Watches">
        {plan.watches.length === 0 ? (
          <p className="text-gray-11">Nothing watched.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {plan.watches.map((w) => (
              <li key={w.title} className="flex flex-wrap items-center gap-2">
                {w.url ? (
                  <a
                    href={w.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-accent-11 underline underline-offset-2"
                  >
                    {w.title}
                  </a>
                ) : (
                  <span>{w.title}</span>
                )}
                {w.condition ? <Badge variant="muted">{w.condition}</Badge> : null}
                {w.lastValue ? (
                  <span className="text-caption text-gray-11">last: {w.lastValue}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Notes">
        {plan.notesMd.trim() === "" ? (
          <p className="text-gray-11">No notes.</p>
        ) : (
          <Markdown className="text-sm">{plan.notesMd}</Markdown>
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
        toast(`Deleted "${goal.title}".`);
        onDeleted?.(goal);
      },
      (err: unknown) => {
        toast.error(
          `Psyche couldn't delete "${goal.title}" (${err instanceof Error ? err.message : String(err)}). The goal is unchanged.`,
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
