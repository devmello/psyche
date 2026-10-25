import type { Goal } from "@psyche/protocol";
import { CircleCheck, Goal as GoalIcon, Plus, Sparkles } from "lucide-react";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState, LoadingCards, useDelayedFlag } from "../../components/page.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Progress } from "../../components/ui/progress.tsx";
import { useGoals } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { cn } from "../../lib/utils.ts";
import { ListItem } from "../../motion/index.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import { ScreenToolbar, ToolbarLabel } from "../feed/ScreenToolbar.tsx";
import { EvidenceLine } from "../ideas/evidence.tsx";
import { AddGoalDialog } from "./AddGoalDialog.tsx";
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

/**
 * A sidebar-style list row (redesign §5.6, §3.7: 44 px two-line rows): title, next check-in and a
 * thin milestone bar. The selection is the accent-tinted pill, like the app sidebar's.
 */
export function GoalRow({ goal, selected = false, onOpen }: GoalRowProps): ReactElement {
  const { done, total } = milestoneProgress(readGoalPlan(goal).milestones);
  const complete = total > 0 && done === total;
  return (
    <div
      className={cn(
        "relative flex min-h-11 flex-col justify-center gap-1 rounded-sm px-2.5 py-1.5 transition-colors",
        selected ? "bg-selection" : "hover:bg-fill-quaternary",
      )}
    >
      <div className="flex items-baseline gap-2">
        <button
          type="button"
          aria-current={selected ? "page" : undefined}
          onClick={() => onOpen?.(goal)}
          className={cn(
            "min-w-0 flex-1 truncate text-start text-headline focus-visible:outline-2 focus-visible:outline-ring",
            "after:absolute after:inset-0 after:rounded-sm after:content-['']",
            "text-label-primary",
          )}
        >
          {goal.title}
        </button>
        {total > 0 ? (
          <span className="text-callout text-label-secondary tabular-nums" aria-hidden="true">
            {done}/{total}
          </span>
        ) : null}
      </div>
      <p className="truncate text-callout text-label-secondary">
        {t("screens.goals.listLine", {
          checkin: goal.nextCheckinAt
            ? t("screens.goals.nextCheckin", { when: formatWhen(goal.nextCheckinAt) })
            : t("screens.goals.noCheckins"),
          status: goal.status,
          inactive: goal.status !== "active",
        })}
      </p>
      {total > 0 ? (
        <Progress
          value={(done / total) * 100}
          aria-label={t("screens.goals.progressLabel", { title: goal.title, done, total })}
          className={cn(
            "[&_[data-slot=progress-track]]:h-1",
            complete ? "[&_[data-slot=progress-indicator]]:bg-grass-9" : "",
          )}
        />
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

/**
 * Inferred goal (redesign §5.6): a level-1 card with a sparkle glyph, the "Because:" evidence and
 * Confirm (primary) / Not a goal / Later. Nothing exists before Confirm.
 */
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
      className="flex flex-col gap-2 rounded-lg bg-surface-raised p-3 shadow-elevation-1"
    >
      <p className="flex items-center gap-1 text-caption text-label-secondary">
        <Sparkles className="size-3.5 text-accent-11" aria-hidden="true" />
        {t("screens.goals.inferred", { category: GOAL_CATEGORY_LABEL[goal.category] })}
      </p>
      <div className="flex flex-col gap-0.5">
        <h3 id={titleId} className="text-headline text-label-primary">
          {goal.title}
        </h3>
        <p className="text-callout text-label-secondary">
          {t("screens.goals.thinks", { name: persona })}
        </p>
      </div>
      <EvidenceLine items={evidence} {...(onOpenRoute ? { onOpenRoute } : {})} />
      <div className="mt-1 flex flex-wrap gap-1.5">
        <Button type="button" size="sm" disabled={busy} onClick={() => onDecide?.(goal, "confirm")}>
          {t("screens.goals.confirm")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onDecide?.(goal, "reject")}
        >
          {t("screens.goals.notAGoal")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onDecide?.(goal, "later")}
        >
          {t("screens.goals.later")}
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
      <LoadingCards label={t("screens.goals.loadingList")} count={4} lines={2} layout="rows" />
    ) : (
      <div aria-busy="true" className="min-h-24" />
    );
  } else if (error !== null) {
    list = (
      <ErrorState
        what={t("screens.goals.listFailed")}
        reason={error}
        did={t("screens.goals.stillRun")}
        {...(onRetry ? { retry: { onClick: onRetry } } : {})}
      />
    );
  } else if (goals.length === 0 && candidates.length === 0) {
    list = (
      <EmptyState
        icon={CircleCheck}
        {...(onAddGoal ? { action: { label: t("screens.goals.add"), onClick: onAddGoal } } : {})}
      >
        {t("screens.goals.empty", { name: persona })}
      </EmptyState>
    );
  } else {
    list = (
      <div className="flex flex-col gap-4">
        {groups.map((group) => (
          <section key={group.category} aria-labelledby={`goals-${group.category}`}>
            {/* Group labels read like the sidebar's: text-caption, sentence case (§3.2). */}
            <h2
              id={`goals-${group.category}`}
              className="px-2.5 pb-1 text-caption text-label-tertiary"
            >
              {GOAL_CATEGORY_LABEL[group.category]}
            </h2>
            <ul className="flex flex-col gap-0.5">
              {group.goals.map((g, i) => (
                <ListItem key={g.id} index={i}>
                  <GoalRow
                    goal={g}
                    selected={g.id === selectedGoalId}
                    {...(onOpenGoal ? { onOpen: onOpenGoal } : {})}
                  />
                </ListItem>
              ))}
            </ul>
          </section>
        ))}
        {goals.length === 0 ? (
          <p className="px-2.5 text-callout text-label-secondary">
            {t("screens.goals.noConfirmed", { name: persona })}
          </p>
        ) : null}
        {candidates.length > 0 ? (
          <section aria-labelledby="goals-candidates" className="flex flex-col gap-1">
            <h2 id="goals-candidates" className="px-2.5 pb-1 text-caption text-label-tertiary">
              {t("screens.goals.suggested")}
            </h2>
            <ul className="flex flex-col gap-2">
              {candidates.map((g, i) => (
                <ListItem key={g.id} index={i}>
                  <CandidateGoalCard
                    goal={g}
                    persona={persona}
                    {...(onDecide ? { onDecide } : {})}
                    {...(onOpenRoute ? { onOpenRoute } : {})}
                  />
                </ListItem>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    );
  }

  const tracked = !loading && error === null && goals.length > 0;
  const listOnly = loading || error !== null || (goals.length === 0 && candidates.length === 0);
  return (
    <section aria-label={t("screens.goals.title")}>
      <ScreenToolbar
        title={t("screens.goals.title")}
        {...(tracked ? { meta: t("screens.goals.count", { n: goals.length }) } : {})}
        {...(onAddGoal && goals.length > 0
          ? {
              actions: (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  title={t("screens.goals.add")}
                  onClick={onAddGoal}
                >
                  <Plus aria-hidden="true" />
                  <ToolbarLabel>{t("screens.goals.add")}</ToolbarLabel>
                </Button>
              ),
            }
          : {})}
      />
      {listOnly ? (
        // Loading, error and empty states take the centred column (§5.10).
        <div className="mx-auto w-full max-w-[calc(880px+3rem)] px-4 pt-4 pb-12 md:px-6">
          {list}
        </div>
      ) : (
        // The split layout (§5.6): a 280 px sidebar-like list and the goal page.
        <div
          data-slot="goals-split"
          className="mx-auto grid w-full max-w-[calc(280px+880px+5rem)] items-start gap-6 px-4 pt-4 pb-12 md:grid-cols-[280px_minmax(0,1fr)] md:px-6"
        >
          <nav aria-label={t("screens.goals.listLabel")} className="md:sticky md:top-16">
            {list}
          </nav>
          <div className="min-w-0">
            {detail ?? (
              <EmptyState icon={GoalIcon} className="pt-[8vh]">
                {t("screens.goals.pick")}
              </EmptyState>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export interface GoalsScreenProps {
  /** Shows the goal page beside the list. */
  selectedGoalId?: string | null;
  /** Defaults to navigating to `/goals/<id>`. */
  onOpenGoal?: (goal: Goal) => void;
  /** Add a goal; defaults to the add dialog (`goals.create`). */
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
  const [adding, setAdding] = useState(false);

  const decide = (goal: Goal, decision: "confirm" | "reject" | "later") => {
    if (decision === "later") setLater((s) => new Set(s).add(goal.id));
    goals.decide(goal.id, decision).then(
      () => {
        if (decision === "confirm") toast(t("screens.goals.tracking", { title: goal.title }));
        if (decision === "reject") toast(t("screens.goals.rejected", { title: goal.title }));
      },
      (err: unknown) => {
        toast.error(t("screens.goals.decideFailed", { reason: describeError(err) }));
      },
    );
  };

  const empty = goals.goals.length === 0 && goals.candidates.length === 0;
  return (
    <>
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
        onAddGoal={onAddGoal ?? (() => setAdding(true))}
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
      {onAddGoal ? null : (
        <AddGoalDialog
          open={adding}
          onOpenChange={setAdding}
          onAdd={(title, category) =>
            goals.create(title, category).then((goal) => {
              toast(t("screens.goals.added", { title: goal.title }));
              navigate?.(`/goals/${goal.id}`);
            })
          }
        />
      )}
    </>
  );
}
