import type { Idea, NudgeAction } from "@psyche/protocol";
import { ArrowUp, Plus } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { scheduleSentence } from "../agent/UpcomingPanel.tsx";
import { usePrefillComposer } from "../chat/prefill.ts";
import { DelayedSkeletons } from "../components/DelayedSkeleton.tsx";
import { ShowMore } from "../components/show-more.tsx";
import { Button } from "../components/ui/button.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import {
  useCall,
  useGatewayQuery,
  useNotifications,
  useThread,
  useThreads,
} from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { formatRelative } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { ListItem } from "../motion/index.ts";
import { NudgeActions } from "../nudges/NudgeActions.tsx";
import { useUpcomingEntries } from "../overview/useUpcomingEntries.ts";
import { ScreenSection } from "../screens/feed/ScreenToolbar.tsx";
import { AddGoalDialog } from "../screens/goals/AddGoalDialog.tsx";
import { CandidateGoalCard, GoalRow, useGoalDecisions } from "../screens/goals/GoalsScreen.tsx";
import { IdeaCard } from "../screens/ideas/IdeaCard.tsx";
import { useIdeaActions } from "../screens/ideas/use-idea-actions.ts";
import { NeedsYouList, needsYou } from "../screens/inbox/InboxScreen.tsx";
import { usePersona, useSlots } from "../slots.tsx";
import { PastDueAsks } from "./PastDueAsks.tsx";
import { useCatchUp } from "./use-catch-up.ts";

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

/**
 * Approvals and questions waiting on the owner, amber; nothing when none are. A past-due
 * "Did you finish ...?" from the catch-up list is one of them (memory-for-everything §5.6).
 */
export function NeedsYouSection({
  onNavigate,
  now: fixedNow,
}: {
  onNavigate: (to: string) => void;
  now?: number;
}): ReactElement | null {
  const now = useNow(30_000, fixedNow);
  const notifications = needsYou(useNotifications().unresolved, now).length;
  const { asks, busy, act } = useCatchUp();
  const waiting = notifications + asks.length;
  if (waiting === 0) return null;
  return (
    <ScreenSection
      id="needs-you"
      title={t("home.needsYou")}
      large
      needsYou
      meta={t("home.needsYou.count", { n: waiting })}
      actions={
        <Button type="button" size="sm" variant="ghost" onClick={() => onNavigate("/inbox")}>
          {t("home.needsYou.all")}
        </Button>
      }
    >
      <PastDueAsks items={asks} busy={busy} onAct={act} onOpen={onNavigate} />
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
  onNavigate: navigateProp,
  onEdit,
  limit,
}: {
  /** No other control on the page holds the accent. */
  accent: boolean;
  /** Defaults to the slot's `navigate`. */
  onNavigate?: (to: string) => void;
  /** An idea's Edit (opens its brief to change); absent, the card has no Edit. */
  onEdit?: (idea: Idea) => void;
  /** Show this many, the rest behind "Show N more" (default: all). */
  limit?: number;
}): ReactElement | null {
  const { navigate: slotNavigate } = useSlots();
  const onNavigate = navigateProp ?? slotNavigate ?? (() => {});
  const persona = usePersona();
  const { ideas, busy, accept, dismiss, viewSkill } = useIdeaActions();
  const { goals, later, decide } = useGoalDecisions();
  const [expanded, setExpanded] = useState(false);
  const candidates = goals.candidates.filter((g) => !later.has(g.id));
  const all = [
    ...ideas.proposed.map((idea) => ({ kind: "idea" as const, idea })),
    ...candidates.map((goal) => ({ kind: "goal" as const, goal })),
  ];
  const n = all.length;
  if (n === 0) return null;
  const shown = limit === undefined || expanded ? all : all.slice(0, limit);
  return (
    <ScreenSection
      id="suggestions"
      title={t("home.suggestions")}
      large
      description={t("home.suggestions.hint")}
      meta={t("home.suggestions.count", { n })}
    >
      <ul id="suggestions-list" aria-label={t("home.suggestions")} className="flex flex-col gap-3">
        {shown.map((item, i) => (
          <ListItem key={item.kind === "idea" ? item.idea.id : item.goal.id} index={i}>
            {item.kind === "idea" ? (
              <IdeaCard
                idea={item.idea}
                prominent={accent && i === 0}
                busy={busy.has(item.idea.id)}
                onAccept={accept}
                onDismiss={dismiss}
                onViewSkill={viewSkill}
                onOpenRoute={onNavigate}
                {...(onEdit ? { onEdit } : {})}
              />
            ) : (
              <CandidateGoalCard
                goal={item.goal}
                persona={persona.name}
                quiet
                onDecide={decide}
                onOpenRoute={onNavigate}
              />
            )}
          </ListItem>
        ))}
      </ul>
      {limit !== undefined ? (
        <ShowMore
          hidden={n - limit}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          controls="suggestions-list"
        />
      ) : null}
    </ScreenSection>
  );
}

const COMING_UP_ROWS = 3;

/** The next runs, soonest first; a row opens Scheduled, where they are managed. */
export function ComingUpSection({
  onNavigate,
  now: fixedNow,
}: {
  onNavigate: (to: string) => void;
  now?: number;
}): ReactElement | null {
  const now = useNow(30_000, fixedNow);
  const { entries, loading, error, reload } = useUpcomingEntries();
  const rows = entries.flatMap((e) => (e.automation ? [{ ...e, automation: e.automation }] : []));
  const shown = rows.slice(0, COMING_UP_ROWS);
  // Nothing scheduled (or still loading): the section is not drawn, so a quiet day stays short.
  if (rows.length === 0 && (loading || error === null)) return null;
  let body: ReactElement;
  if (rows.length === 0) body = <SectionError what={t("home.comingUp")} onRetry={reload} />;
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
      large
      description={t("home.comingUp.hint")}
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
export function GoalsSection({
  onNavigate,
}: {
  onNavigate: (to: string) => void;
}): ReactElement | null {
  const { goals } = useGoalDecisions();
  const [adding, setAdding] = useState(false);
  const tracked = goals.goals;
  // No goals (or still loading): not drawn. "Add a goal" is in ⌘K and under "Suggestions".
  if (tracked.length === 0 && (goals.loading || goals.error === null)) return null;
  let body: ReactElement;
  if (tracked.length === 0) body = <SectionError what={t("home.goals")} onRetry={goals.reload} />;
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
      large
      description={t("home.goals.hint")}
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
      large
      description={t("home.keepInTouch.hint")}
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

/** The one starting point on Home: ask the persona anything, in the main chat. */
export function AskSection({
  onNavigate,
  accent,
}: {
  onNavigate: (to: string) => void;
  /** No other control on the page holds the accent: the send button may. */
  accent: boolean;
}): ReactElement {
  const persona = usePersona();
  const threads = useThreads();
  const mainId = threads.main?.thread.id ?? null;
  const main = useThread(mainId);
  const prefill = usePrefillComposer();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // Nothing said yet anywhere: a first-time owner gets a few things to try.
  const fresh =
    threads.main !== null &&
    threads.main.thread.lastMessageAt == null &&
    threads.active.length === 0;
  const ask = (question: string) => {
    const q = question.trim();
    if (q === "" || sending) return;
    if (mainId === null) {
      if (prefill) prefill(q);
      else onNavigate("/chat");
      return;
    }
    setSending(true);
    main
      .send(q)
      .then(() => {
        setText("");
        onNavigate("/chat");
      })
      .catch((err: unknown) => toast.error(t("home.ask.failed", { reason: describeError(err) })))
      .finally(() => setSending(false));
  };
  const label = t("home.ask.label", { name: persona.name });
  return (
    <section aria-label={label} className="flex flex-col gap-3" data-testid="section-ask">
      <form
        className="flex h-12 items-center gap-2 rounded-xl bg-surface-raised ps-4 pe-1.5 shadow-elevation-1 focus-within:ring-2 focus-within:ring-ring"
        onSubmit={(e) => {
          e.preventDefault();
          ask(text);
        }}
      >
        <input
          aria-label={label}
          placeholder={label}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={sending}
          className="min-w-0 flex-1 bg-transparent text-body text-label-primary outline-none placeholder:text-label-tertiary"
          data-testid="home-ask"
        />
        <Button
          type="submit"
          size="icon-sm"
          variant={accent && text.trim() !== "" ? "default" : "ghost"}
          disabled={sending || text.trim() === ""}
          aria-label={t("home.ask.send")}
          title={t("home.ask.send")}
        >
          <ArrowUp aria-hidden="true" />
        </Button>
      </form>
      {fresh ? (
        <div className="flex flex-wrap items-center gap-2 px-1" data-testid="home-starters">
          <span className="text-callout text-label-tertiary">{t("home.start.try")}</span>
          {(["planWeek", "brief", "remember"] as const).map((kind) => (
            <Button
              key={kind}
              type="button"
              size="sm"
              variant="secondary"
              disabled={sending}
              onClick={() => ask(t(`home.start.${kind}.prompt`, { name: persona.name }))}
            >
              {t(`home.start.${kind}`, { name: persona.name })}
            </Button>
          ))}
          <Button type="button" size="sm" variant="ghost" onClick={() => onNavigate("/can-do")}>
            {t("capabilities.open")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Everything else, one quiet line at the foot of Home: the deeper pages (run Timelines, Scheduled,
 * notifications, memory, the brief's settings) stay reachable without a sidebar row each
 * (consolidation-2026 §7). Plain links, not a list of cards: it is the end of the page, not a section.
 */
export function MoreSection({ onNavigate }: { onNavigate: (to: string) => void }): ReactElement {
  const persona = usePersona();
  const links: readonly { label: string; hint: string; route: string }[] = [
    {
      label: t("overview.title", { name: persona.name }),
      hint: t("home.more.overview"),
      route: "/overview",
    },
    { label: t("shell.rail.scheduled"), hint: t("home.more.scheduled"), route: "/scheduled" },
    { label: t("screens.inbox.title"), hint: t("home.more.inbox"), route: "/inbox" },
    { label: t("home.more.brief"), hint: t("home.more.briefHint"), route: "/home/instructions" },
    {
      label: t("agent.sheet.soul"),
      hint: t("home.more.soul", { name: persona.name }),
      route: "/agent/soul",
    },
    {
      label: t("home.more.memoryReview"),
      hint: t("home.more.review"),
      route: "/memory/review",
    },
  ];
  return (
    <nav
      id="more"
      aria-label={t("home.more")}
      data-testid="section-more"
      className="flex flex-wrap items-center gap-x-1 gap-y-1"
    >
      {links.map((r) => (
        <Button
          key={r.route}
          type="button"
          size="sm"
          variant="ghost"
          title={r.hint}
          className="text-label-secondary"
          onClick={() => onNavigate(r.route)}
        >
          {r.label}
        </Button>
      ))}
    </nav>
  );
}
