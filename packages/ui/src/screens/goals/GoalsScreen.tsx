import type { Goal } from "@psyche/protocol";
import { Sparkles } from "lucide-react";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "../../components/ui/button.tsx";
import { Progress } from "../../components/ui/progress.tsx";
import { useGoals } from "../../data/hooks.ts";
import { cn } from "../../lib/utils.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import {
  EmptyState,
  ErrorState,
  LoadingCards,
  ScreenHeader,
  useDelayedFlag,
} from "../feed/states.tsx";
import { EvidenceLine } from "../ideas/evidence.tsx";
import { formatWhen, GoalPage } from "./GoalPage.tsx";
import {
  GOAL_CATEGORY_LABEL,
  GOAL_CATEGORY_ORDER,
  milestoneProgress,
  readGoalPlan,
} from "./goal-plan.ts";

export interface GoalRowProps {
  goal: Goal;
  selected?: boolean;
  onOpen?: (goal: Goal) => void;
}

/** List row: title, next check-in, milestone progress bar (UI design §3.11). */
export function GoalRow({ goal, selected = false, onOpen }: GoalRowProps): ReactElement {
  const { done, total } = milestoneProgress(readGoalPlan(goal).milestones);
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-md px-2 py-2",
        selected ? "bg-accent-3" : "hover:bg-gray-3",
      )}
    >
      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        onClick={() => onOpen?.(goal)}
        className="text-left text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring"
      >
        {goal.title}
      </button>
      <p className="text-xs text-muted-foreground">
        {goal.nextCheckinAt ? `Next check-in ${formatWhen(goal.nextCheckinAt)}` : "No check-ins"}
        {goal.status !== "active" ? ` · ${goal.status}` : ""}
      </p>
      {total > 0 ? (
        <div className="flex items-center gap-2">
          <Progress
            value={(done / total) * 100}
            aria-label={`${goal.title}: ${done} of ${total} milestones`}
            className="flex-1"
          />
          <span className="text-xs text-muted-foreground tabular-nums" aria-hidden="true">
            {done}/{total}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export interface CandidateGoalCardProps {
  goal: Goal;
  persona?: string;
  onDecide?: (goal: Goal, decision: "confirm" | "reject" | "later") => void;
  onOpenRoute?: (route: string) => void;
  busy?: boolean;
}

/** Inferred goal: "Because:" evidence, Confirm / Not a goal / Later; nothing exists before Confirm. */
export function CandidateGoalCard({
  goal,
  persona = "Wren",
  onDecide,
  onOpenRoute,
  busy = false,
}: CandidateGoalCardProps): ReactElement {
  const titleId = useId();
  const evidence = readGoalPlan(goal).evidence;
  return (
    <article
      aria-labelledby={titleId}
      className="rounded-lg border border-dashed border-accent-7 bg-accent-2 p-3"
    >
      <p className="flex items-center gap-1 text-label font-semibold text-accent-11 uppercase">
        <Sparkles className="size-3" aria-hidden="true" />
        Inferred goal · {GOAL_CATEGORY_LABEL[goal.category]}
      </p>
      <h3 id={titleId} className="mt-1 text-sm font-semibold">
        {goal.title}
      </h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {persona} thinks this might be a goal. Nothing is tracked until you confirm.
      </p>
      <EvidenceLine items={evidence} className="mt-1" {...(onOpenRoute ? { onOpenRoute } : {})} />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={() => onDecide?.(goal, "confirm")}>
          Confirm
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onDecide?.(goal, "reject")}
        >
          Not a goal
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onDecide?.(goal, "later")}
        >
          Later
        </Button>
      </div>
    </article>
  );
}

export interface GoalsViewProps {
  goals: readonly Goal[];
  candidates?: readonly Goal[];
  loading?: boolean;
  loadingDelayMs?: number;
  error?: string | null;
  onRetry?: () => void;
  selectedGoalId?: string | null;
  persona?: string;
  onOpenGoal?: (goal: Goal) => void;
  onDecide?: (goal: Goal, decision: "confirm" | "reject" | "later") => void;
  onOpenRoute?: (route: string) => void;
  /** The empty state's one action. */
  onAddGoal?: () => void;
  /** The goal page beside the list (wide layout). */
  detail?: ReactNode;
}

/** Goals by category with inferred-goal cards (UI design §3.11). Presentational. */
export function GoalsView({
  goals,
  candidates = [],
  loading = false,
  loadingDelayMs = 0,
  error = null,
  onRetry,
  selectedGoalId = null,
  persona = "Wren",
  onOpenGoal,
  onDecide,
  onOpenRoute,
  onAddGoal,
  detail,
}: GoalsViewProps): ReactElement {
  const showSkeleton = useDelayedFlag(loading, loadingDelayMs);
  const groups = GOAL_CATEGORY_ORDER.map((category) => ({
    category,
    goals: goals.filter((g) => g.category === category),
  })).filter((g) => g.goals.length > 0);

  let list: ReactElement;
  if (loading) {
    list = showSkeleton ? (
      <LoadingCards label="Loading goals" count={4} lines={2} layout="rows" />
    ) : (
      <div aria-busy="true" className="min-h-24" />
    );
  } else if (error !== null) {
    list = (
      <ErrorState
        what="Psyche couldn't load your goals"
        reason={error}
        did="Check-ins still run on schedule."
        {...(onRetry ? { retry: { onClick: onRetry } } : {})}
      />
    );
  } else if (goals.length === 0 && candidates.length === 0) {
    list = (
      <EmptyState {...(onAddGoal ? { action: { label: "Add a goal", onClick: onAddGoal } } : {})}>
        Tell {persona} a goal in chat, or add one here.
      </EmptyState>
    );
  } else {
    list = (
      <div className="flex flex-col gap-4">
        {groups.map((group) => (
          <section key={group.category} aria-labelledby={`goals-${group.category}`}>
            <h2
              id={`goals-${group.category}`}
              className="px-2 text-label font-semibold text-muted-foreground uppercase"
            >
              {GOAL_CATEGORY_LABEL[group.category]}
            </h2>
            <ul className="mt-1 flex flex-col gap-0.5">
              {group.goals.map((g) => (
                <li key={g.id}>
                  <GoalRow
                    goal={g}
                    selected={g.id === selectedGoalId}
                    {...(onOpenGoal ? { onOpen: onOpenGoal } : {})}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
        {goals.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">
            No confirmed goals yet. Tell {persona} a goal in chat, or confirm one below.
          </p>
        ) : null}
        {candidates.length > 0 ? (
          <section aria-labelledby="goals-candidates" className="flex flex-col gap-2">
            <h2
              id="goals-candidates"
              className="px-2 text-label font-semibold text-muted-foreground uppercase"
            >
              Suggested
            </h2>
            <ul className="flex flex-col gap-2">
              {candidates.map((g) => (
                <li key={g.id}>
                  <CandidateGoalCard
                    goal={g}
                    persona={persona}
                    {...(onDecide ? { onDecide } : {})}
                    {...(onOpenRoute ? { onOpenRoute } : {})}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    );
  }

  return (
    <section aria-label="Goals" className="flex flex-col gap-4 p-4">
      <ScreenHeader
        title="Goals"
        {...(onAddGoal && goals.length > 0
          ? {
              actions: (
                <Button type="button" size="sm" variant="outline" onClick={onAddGoal}>
                  Add a goal
                </Button>
              ),
            }
          : {})}
      />
      <div
        className={cn(
          detail ? "grid gap-6 md:grid-cols-[minmax(220px,280px)_1fr]" : "max-w-[68ch]",
        )}
      >
        <div>{list}</div>
        {detail ? <div className="min-w-0">{detail}</div> : null}
      </div>
    </section>
  );
}

export interface GoalsScreenProps {
  /** Shows the goal page beside the list. */
  selectedGoalId?: string | null;
  /** Defaults to navigating to `/goals/<id>`. */
  onOpenGoal?: (goal: Goal) => void;
  /** The empty state's action; defaults to opening the main chat. */
  onAddGoal?: () => void;
  /** Passed to the goal page; defaults to `goals.archive`. */
  onDeleteGoal?: (goal: Goal) => Promise<unknown> | undefined;
}

/** Connected Goals: `goals.list`, `goals.decide`, and the goal page for the selected goal. */
export function GoalsScreen({
  selectedGoalId = null,
  onOpenGoal,
  onAddGoal,
  onDeleteGoal,
}: GoalsScreenProps): ReactElement {
  const { navigate } = useSlots();
  const persona = usePersona();
  const goals = useGoals();
  /** "Later" leaves a candidate as it is; hide it for this visit. */
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());

  const decide = (goal: Goal, decision: "confirm" | "reject" | "later") => {
    if (decision === "later") setLater((s) => new Set(s).add(goal.id));
    goals.decide(goal.id, decision).then(
      () => {
        if (decision === "confirm") toast(`Tracking "${goal.title}".`);
        if (decision === "reject") toast(`Got it. "${goal.title}" isn't a goal.`);
      },
      (err: unknown) => {
        toast.error(
          `Psyche couldn't save that (${err instanceof Error ? err.message : String(err)}). The suggestion is unchanged.`,
        );
      },
    );
  };

  const empty = goals.goals.length === 0 && goals.candidates.length === 0;
  return (
    <GoalsView
      goals={goals.goals}
      candidates={goals.candidates.filter((g) => !later.has(g.id))}
      loading={goals.loading && empty}
      loadingDelayMs={150}
      error={empty ? goals.error : null}
      onRetry={goals.reload}
      selectedGoalId={selectedGoalId}
      persona={persona.name}
      onOpenGoal={onOpenGoal ?? ((g) => navigate?.(`/goals/${g.id}`))}
      onDecide={decide}
      onOpenRoute={(route) => navigate?.(route)}
      onAddGoal={onAddGoal ?? (() => navigate?.("/chat"))}
      detail={
        selectedGoalId === null ? undefined : (
          <GoalPage
            goalId={selectedGoalId}
            onDeleted={() => navigate?.("/goals")}
            {...(onDeleteGoal ? { onDelete: onDeleteGoal } : {})}
          />
        )
      }
    />
  );
}
