import type { NudgeAction } from "@psyche/protocol";
import { ChevronRight, Plus } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { scheduleSentence } from "../agent/UpcomingPanel.tsx";
import { usePrefillComposer } from "../chat/prefill.ts";
import { DelayedSkeletons } from "../components/DelayedSkeleton.tsx";
import { Button } from "../components/ui/button.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { useCall, useGatewayQuery, useNotifications } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { formatRelative } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { ListItem } from "../motion/index.ts";
import { NudgeActions } from "../nudges/NudgeActions.tsx";
import { useUpcomingEntries } from "../overview/useUpcomingEntries.ts";
import { ScreenSection } from "../screens/feed/ScreenToolbar.tsx";
import { AddGoalDialog } from "../screens/goals/AddGoalDialog.tsx";
import { CandidateGoalCard, GoalRow, useGoalDecisions } from "../screens/goals/GoalsScreen.tsx";
import { IdeaCard } from "../screens/ideas/IdeaCard.tsx";
import { useIdeaActions } from "../screens/ideas/IdeasScreen.tsx";
import { NeedsYouList, needsYou } from "../screens/inbox/InboxScreen.tsx";
import { usePersona } from "../slots.tsx";

/** A raised list of rows (the grouped-list surface), for the side column's sections. */
function RowList({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <ul
      aria-label={label}
      className="flex flex-col rounded-lg bg-surface-raised p-1 shadow-elevation-1"
    >
      {children}
    </ul>
  );
}

/** Two row-shaped skeletons, after the usual delay. */
function RowSkeletons({ label }: { label: string }): ReactElement {
  return (
    <DelayedSkeletons label={label} className="flex flex-col gap-1 rounded-lg p-1">
      {[0, 1].map((i) => (
        <div key={i} className="flex min-h-11 flex-col justify-center gap-1.5 px-2.5">
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </DelayedSkeletons>
  );
}

/** A load that failed, in one quiet line with "Try again". */
function SectionError({ what, onRetry }: { what: string; onRetry: () => void }): ReactElement {
  return (
    <p className="flex flex-wrap items-center gap-x-2 px-1 text-callout text-label-secondary">
      {t("home.loadFailed", { what })}
      <Button type="button" size="xs" variant="plain" onClick={onRetry}>
        {t("common.tryAgain")}
      </Button>
    </p>
  );
}

/** Approvals and questions waiting on the owner, amber; nothing when none are. */
export function NeedsYouSection({
  onNavigate,
  now: fixedNow,
}: {
  onNavigate: (to: string) => void;
  now?: number;
}): ReactElement | null {
  const now = useNow(30_000, fixedNow);
  const waiting = needsYou(useNotifications().unresolved, now).length;
  if (waiting === 0) return null;
  return (
    <ScreenSection
      id="needs-you"
      title={t("home.needsYou")}
      needsYou
      meta={t("home.needsYou.count", { n: waiting })}
      actions={
        <Button type="button" size="sm" variant="ghost" onClick={() => onNavigate("/inbox")}>
          {t("home.needsYou.all")}
        </Button>
      }
    >
      <NeedsYouList {...(fixedNow === undefined ? {} : { now: fixedNow })} />
    </ScreenSection>
  );
}

/**
 * Ideas and inferred goals (they were two pages). The first idea carries the accent only when
 * nothing needs the owner; inferred goals always use outline buttons.
 */
export function SuggestionsSection({
  accent,
  onNavigate,
}: {
  /** No other control on the page holds the accent. */
  accent: boolean;
  onNavigate: (to: string) => void;
}): ReactElement | null {
  const persona = usePersona();
  const { ideas, busy, accept, dismiss, viewSkill } = useIdeaActions();
  const { goals, later, decide } = useGoalDecisions();
  const candidates = goals.candidates.filter((g) => !later.has(g.id));
  const n = ideas.proposed.length + candidates.length;
  if (n === 0) return null;
  return (
    <ScreenSection
      id="suggestions"
      title={t("home.suggestions")}
      meta={t("home.suggestions.count", { n })}
    >
      <ul aria-label={t("home.suggestions")} className="flex flex-col gap-3">
        {ideas.proposed.map((idea, i) => (
          <ListItem key={idea.id} index={i}>
            <IdeaCard
              idea={idea}
              prominent={accent && i === 0}
              busy={busy.has(idea.id)}
              onAccept={accept}
              onDismiss={dismiss}
              onViewSkill={viewSkill}
              onOpenRoute={onNavigate}
            />
          </ListItem>
        ))}
        {candidates.map((goal, i) => (
          <ListItem key={goal.id} index={ideas.proposed.length + i}>
            <CandidateGoalCard
              goal={goal}
              persona={persona.name}
              quiet
              onDecide={decide}
              onOpenRoute={onNavigate}
            />
          </ListItem>
        ))}
      </ul>
    </ScreenSection>
  );
}

const COMING_UP_ROWS = 5;

/** The next runs, soonest first; a row opens Scheduled, where they are managed. */
export function ComingUpSection({
  onNavigate,
  now: fixedNow,
}: {
  onNavigate: (to: string) => void;
  now?: number;
}): ReactElement {
  const now = useNow(30_000, fixedNow);
  const { entries, loading, error, reload } = useUpcomingEntries();
  const rows = entries.flatMap((e) => (e.automation ? [{ ...e, automation: e.automation }] : []));
  const shown = rows.slice(0, COMING_UP_ROWS);
  let body: ReactElement;
  if (loading && rows.length === 0) body = <RowSkeletons label={t("home.comingUp")} />;
  else if (error !== null && rows.length === 0)
    body = <SectionError what={t("home.comingUp")} onRetry={reload} />;
  else if (rows.length === 0)
    body = <p className="px-1 text-callout text-label-secondary">{t("agent.upcoming.empty")}</p>;
  else
    body = (
      <RowList label={t("home.comingUp")}>
        {shown.map(({ item, automation: a }) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => onNavigate("/scheduled")}
              aria-label={t("home.comingUp.open", { title: a.title })}
              className="flex min-h-11 w-full flex-col justify-center gap-0.5 rounded-sm px-2.5 py-1.5 text-start outline-none transition-colors hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate text-body text-label-primary">{a.title}</span>
              <span className="truncate text-callout text-label-secondary tabular-nums">
                {t("home.comingUp.line", {
                  schedule: scheduleSentence(a),
                  next:
                    item.nextRunAt != null && Date.parse(item.nextRunAt) >= now
                      ? formatRelative(item.nextRunAt, now)
                      : t("agent.upcoming.dueNow"),
                })}
              </span>
            </button>
          </li>
        ))}
        {rows.length > shown.length ? (
          <li className="px-2.5 py-1.5 text-callout text-label-tertiary">
            {t("home.comingUp.more", { n: rows.length - shown.length })}
          </li>
        ) : null}
      </RowList>
    );
  return (
    <ScreenSection
      id="coming-up"
      title={t("home.comingUp")}
      actions={
        <Button type="button" size="sm" variant="ghost" onClick={() => onNavigate("/scheduled")}>
          {t("home.comingUp.all")}
        </Button>
      }
    >
      {body}
    </ScreenSection>
  );
}

/** Tracked goals as rows (a row opens the goal's page), with Add a goal. */
export function GoalsSection({ onNavigate }: { onNavigate: (to: string) => void }): ReactElement {
  const persona = usePersona();
  const { goals } = useGoalDecisions();
  const [adding, setAdding] = useState(false);
  const tracked = goals.goals;
  let body: ReactElement;
  if (goals.loading && goals.goals.length === 0) body = <RowSkeletons label={t("home.goals")} />;
  else if (goals.error !== null && goals.goals.length === 0)
    body = <SectionError what={t("home.goals")} onRetry={goals.reload} />;
  else if (tracked.length === 0)
    body = (
      <p className="px-1 text-callout text-label-secondary">
        {t("home.goals.empty", { name: persona.name })}
      </p>
    );
  else
    body = (
      <RowList label={t("home.goals")}>
        {tracked.map((goal) => (
          <li key={goal.id}>
            <GoalRow goal={goal} onOpen={(g) => onNavigate(`/goals/${g.id}`)} />
          </li>
        ))}
      </RowList>
    );
  return (
    <ScreenSection
      id="goals"
      title={t("home.goals")}
      actions={
        <>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t("screens.goals.add")}
            title={t("screens.goals.add")}
            onClick={() => setAdding(true)}
          >
            <Plus aria-hidden="true" />
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => onNavigate("/goals")}>
            {t("home.goals.all")}
          </Button>
        </>
      }
    >
      {body}
      <AddGoalDialog
        open={adding}
        onOpenChange={setAdding}
        onAdd={(title, category) =>
          goals.create(title, category).then((goal) => {
            toast(t("screens.goals.added", { title: goal.title }));
            onNavigate(`/goals/${goal.id}`);
          })
        }
      />
    </ScreenSection>
  );
}

const NUDGES_SHOWN = 3;

/** Relationship nudges, at most three; nothing while the feature is off or quiet. */
export function KeepInTouchSection({
  onNavigate,
  limit = NUDGES_SHOWN,
  showPeopleLink = true,
}: {
  onNavigate: (to: string) => void;
  limit?: number;
  /** People's own copy of the section leaves the link out. */
  showPeopleLink?: boolean;
}): ReactElement | null {
  const call = useCall();
  const list = useGatewayQuery("nudges.list", {});
  const prefill = usePrefillComposer();
  const items = list.data?.enabled ? list.data.items.slice(0, limit) : [];
  if (items.length === 0) return null;
  return (
    <ScreenSection
      id="keep-in-touch"
      title={t("home.keepInTouch")}
      {...(showPeopleLink
        ? {
            actions: (
              <Button type="button" size="sm" variant="ghost" onClick={() => onNavigate("/people")}>
                {t("home.keepInTouch.people")}
              </Button>
            ),
          }
        : {})}
    >
      <RowList label={t("home.keepInTouch")}>
        {items.map((item) => (
          <li
            key={item.id}
            className="relative flex flex-col gap-2 px-2.5 py-2.5 before:absolute before:inset-x-2.5 before:top-0 before:h-px before:bg-separator first:before:hidden"
          >
            <p className="text-body text-label-primary">{item.text}</p>
            <NudgeActions
              key={item.id}
              item={item}
              quiet
              {...(prefill ? { onDraft: prefill } : {})}
              onAct={(action: NudgeAction) =>
                call("nudges.act", { id: item.id, action }).finally(() => list.reload())
              }
            />
          </li>
        ))}
      </RowList>
    </ScreenSection>
  );
}

/** One quiet row into "{persona} & you" (the Overview): activity, growth, what was built. */
export function AboutYouLink({ onNavigate }: { onNavigate: (to: string) => void }): ReactElement {
  const persona = usePersona();
  return (
    <ScreenSection id="you" title={t("overview.title", { name: persona.name })}>
      <button
        type="button"
        onClick={() => onNavigate("/overview")}
        className="flex min-h-11 items-center gap-2 rounded-lg bg-surface-raised px-3.5 py-2 text-start text-body text-label-primary shadow-elevation-1 outline-none transition-colors hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1">{t("home.you.link", { name: persona.name })}</span>
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 text-label-tertiary rtl:-scale-x-100"
        />
      </button>
    </ScreenSection>
  );
}
