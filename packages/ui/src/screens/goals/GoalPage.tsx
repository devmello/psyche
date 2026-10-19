import type { Artifact, Goal, GoalMilestone, Task } from "@psyche/protocol";
import { Circle, CircleCheck, Ellipsis, FileText, Trash2 } from "lucide-react";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { Markdown } from "../../blocks/Markdown.tsx";
import { TASK_STATUS_LABEL, TaskStatusIcon } from "../../blocks/TaskCard.tsx";
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
import { formatDate, formatTime } from "../../lib/format.ts";
import { cn } from "../../lib/utils.ts";
import { useSlots } from "../../slots.tsx";
import { ErrorState, LoadingCards, useDelayedFlag } from "../feed/states.tsx";
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
    <section className="grid gap-1 border-t border-gray-6 py-3 sm:grid-cols-[8rem_1fr] sm:gap-4">
      <h3 className="text-label font-semibold text-muted-foreground uppercase">{title}</h3>
      <div className="min-w-0 text-sm">{children}</div>
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
  if (task === null) return <span className="text-muted-foreground">Loading task…</span>;
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
      <span className="text-xs text-muted-foreground">{TASK_STATUS_LABEL[task.status]}</span>
    </span>
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

  return (
    <article aria-labelledby={titleId} className="flex flex-col">
      <header className="flex items-start gap-2 pb-3">
        <div className="min-w-0 flex-1">
          <p className="text-label font-semibold text-muted-foreground uppercase">
            {GOAL_CATEGORY_LABEL[goal.category]}
            {goal.status !== "active" ? ` · ${goal.status}` : ""}
          </p>
          <h2 id={titleId} className="text-xl font-semibold">
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
          <p className="text-muted-foreground">No milestones yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {items.map((m) => (
              <li key={m.title} className="flex items-center gap-2">
                {m.done ? (
                  <CircleCheck className="size-4 text-success" aria-hidden="true" />
                ) : (
                  <Circle className="size-4 text-gray-9" aria-hidden="true" />
                )}
                <span className={cn(m.done ? "text-gray-11" : "")}>{m.title}</span>
                <span className="sr-only">{m.done ? "(done)" : "(not done)"}</span>
                {m.dueAt ? (
                  <span className="text-xs text-muted-foreground">due {formatDate(m.dueAt)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Plan">
        {plan.planArtifactId === null ? (
          <p className="text-muted-foreground">No plan yet. Ask in chat for one.</p>
        ) : planArtifact === null ? (
          <p className="text-muted-foreground">Loading the plan…</p>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={onOpenArtifact === undefined}
            onClick={() => onOpenArtifact?.(planArtifact)}
          >
            <FileText aria-hidden="true" />
            {planArtifact.title} ({planArtifact.type.toUpperCase()}) · v{planArtifact.version}
          </Button>
        )}
      </Section>

      <Section title="Tasks">
        {taskIds.length === 0 ? (
          <p className="text-muted-foreground">No linked tasks.</p>
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
          <p className="text-muted-foreground">Nothing watched.</p>
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
                {w.condition ? <Badge variant="outline">{w.condition}</Badge> : null}
                {w.lastValue ? (
                  <span className="text-xs text-muted-foreground">last: {w.lastValue}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Notes">
        {plan.notesMd.trim() === "" ? (
          <p className="text-muted-foreground">No notes.</p>
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
