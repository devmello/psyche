import type { FeedPost } from "@psyche/protocol";
import { CalendarClock, CircleAlert, Loader, Newspaper, PenLine } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState, LoadingCards, useDelayedFlag } from "../../components/page.tsx";
import { Button } from "../../components/ui/button.tsx";
import { useFeed, useSettings } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { formatTime } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { ListItem } from "../../motion/index.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import { FeedSpecialistResults } from "../../specialists/FeedResults.tsx";
import { FeedInstructionsSheet } from "./FeedInstructionsSheet.tsx";
import { type FeedFeedbackValue, FeedPostCard } from "./FeedPostCard.tsx";
import { feedKind, feedTopic, primarySource } from "./feed-post.ts";
import { ScreenColumn, ScreenToolbar, ToolbarLabel } from "./ScreenToolbar.tsx";

/** A source the brief could not read (the protocol has no field for it yet; see the report). */
export interface FeedSourceFailure {
  source: string;
  /** Short reason, e.g. "needs sign-in". */
  reason: string;
  /** Route that fixes it, e.g. `/settings/connectors`. */
  route?: string;
}

export interface FeedViewProps {
  posts: readonly FeedPost[];
  nextBriefAt: string | null;
  loading?: boolean;
  /** Skeletons appear after this delay (150 ms in the connected screen, §3.0). */
  loadingDelayMs?: number;
  error?: string | null;
  onRetry?: () => void;
  /** The first brief is being written. */
  generating?: boolean;
  sourceFailures?: readonly FeedSourceFailure[];
  persona?: string;
  onFeedback?: (post: FeedPost, feedback: FeedFeedbackValue | null, topic?: string) => void;
  onAsk?: (post: FeedPost) => void;
  onEditInstructions?: () => void;
  onSchedule?: () => void;
  onGenerate?: () => void;
  onOpenRoute?: (route: string) => void;
  /** Specialists' results, above the brief, when the owner turned them on (specialists §6.2). */
  specialistResults?: ReactNode;
}

/** The Feed (UI design §3.9): a bounded daily brief with an end marker. Presentational. */
export function FeedView({
  posts,
  nextBriefAt,
  loading = false,
  loadingDelayMs = 0,
  error = null,
  onRetry,
  generating = false,
  sourceFailures = [],
  persona = "Wren",
  onFeedback,
  onAsk,
  onEditInstructions,
  onSchedule,
  onGenerate,
  onOpenRoute,
  specialistResults,
}: FeedViewProps): ReactElement {
  const nextAt = nextBriefAt === null ? null : formatTime(nextBriefAt);
  const settled = !loading && error === null;
  const showSkeleton = useDelayedFlag(loading, loadingDelayMs);
  // The briefing is the hero at the top (§5.6); the rest keep the Gateway's order.
  const ordered = [
    ...posts.filter((p) => feedKind(p) === "briefing"),
    ...posts.filter((p) => feedKind(p) !== "briefing"),
  ];

  let body: ReactElement;
  if (loading) {
    body = showSkeleton ? (
      <LoadingCards label={t("screens.feed.loading")} count={3} lines={3} />
    ) : (
      <div aria-busy="true" className="min-h-24" />
    );
  } else if (error !== null) {
    body = (
      <ErrorState
        what={t("screens.feed.loadFailed")}
        reason={error}
        did={t("screens.feed.safe")}
        {...(onRetry ? { retry: { onClick: onRetry } } : {})}
      />
    );
  } else if (generating && posts.length === 0) {
    body = (
      <div className="flex flex-col gap-3">
        <p role="status" className="flex items-center gap-2 text-body text-label-secondary">
          <Loader
            className="size-4 text-label-secondary animate-spin reduced:animate-none"
            aria-hidden="true"
          />
          {t("screens.feed.writingFirst")}
        </p>
        <LoadingCards label={t("screens.feed.generating")} count={2} lines={3} />
      </div>
    );
  } else if (posts.length === 0) {
    body = (
      <EmptyState
        icon={Newspaper}
        {...(onGenerate
          ? { action: { label: t("screens.feed.generateFirst"), onClick: onGenerate } }
          : {})}
      >
        {t("screens.feed.empty", { at: nextAt ?? "07:00" })}
      </EmptyState>
    );
  } else {
    body = (
      <>
        <ul aria-label={t("screens.feed.posts")} className="flex flex-col gap-3">
          {ordered.map((post, i) => (
            <ListItem key={post.id} index={i}>
              <FeedPostCard
                post={post}
                persona={persona}
                {...(onFeedback ? { onFeedback } : {})}
                {...(onAsk ? { onAsk } : {})}
              />
            </ListItem>
          ))}
        </ul>
        {/* The end marker (§5.6): one centred line with 48 px of space above. */}
        <p className="pt-12 text-center text-callout text-label-secondary">
          {t("screens.feed.end", { next: nextAt ?? "", hasNext: Boolean(nextAt) })}
        </p>
      </>
    );
  }

  return (
    <section aria-label={t("screens.feed.title")}>
      <ScreenToolbar
        title={t("screens.feed.title")}
        meta={
          settled && posts.length > 0
            ? t("screens.feed.todayPosts", { n: posts.length })
            : t("screens.feed.today")
        }
        actions={
          <>
            {onEditInstructions ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                title={t("screens.feed.instructions")}
                onClick={onEditInstructions}
              >
                <PenLine aria-hidden="true" />
                <ToolbarLabel>{t("screens.feed.instructions")}</ToolbarLabel>
              </Button>
            ) : null}
            {onSchedule ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                title={t("screens.feed.schedule")}
                onClick={onSchedule}
              >
                <CalendarClock aria-hidden="true" />
                <ToolbarLabel>{t("screens.feed.schedule")}</ToolbarLabel>
              </Button>
            ) : null}
          </>
        }
      />
      <ScreenColumn width="reading">
        {settled && sourceFailures.length > 0 ? (
          <ul
            aria-label={t("screens.feed.skipped")}
            className="flex flex-col rounded-lg bg-surface-raised shadow-elevation-1"
          >
            {sourceFailures.map((f) => (
              <li
                key={f.source}
                className="relative flex min-h-9 flex-wrap items-center gap-3 px-3 py-1.5 text-body before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator first:before:hidden"
              >
                <CircleAlert className="size-4 shrink-0 text-approval-text" aria-hidden="true" />
                <span className="min-w-0 flex-1 text-label-primary">
                  {t("screens.feed.sourceFailed", { source: f.source, reason: f.reason })}
                </span>
                {f.route !== undefined && onOpenRoute ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="plain"
                    onClick={() => onOpenRoute(f.route ?? "")}
                    aria-label={t("screens.feed.fixSource", { source: f.source })}
                  >
                    {t("screens.feed.fix")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {settled ? specialistResults : null}
        {body}
      </ScreenColumn>
    </section>
  );
}

export interface FeedScreenProps {
  /** Opens a side chat seeded with the post (Psyche decision, §3.9). */
  onAsk?: (post: FeedPost) => void;
  /**
   * Replaces the built-in instructions sheet. By default the button opens the Feed instructions
   * sheet over the feed and navigates to `/feed/instructions` (issue #614).
   */
  onEditInstructions?: () => void;
  /** The route has the instructions sheet open (`/feed/instructions`). */
  instructionsOpen?: boolean;
  /** Closing the instructions sheet; defaults to navigating back to `/feed`. */
  onCloseInstructions?: () => void;
  /**
   * Defaults to the Overview's Upcoming section (`/overview#upcoming`), where briefings are
   * scheduled.
   */
  onSchedule?: () => void;
  /** Defaults to `feed.generate` through `useFeed().generate`. */
  onGenerate?: () => Promise<unknown> | undefined;
  sourceFailures?: readonly FeedSourceFailure[];
  /** Fixed clock (stories, tests). */
  now?: number;
}

const FEEDBACK_TOAST: Record<FeedFeedbackValue, (post: FeedPost) => string> = {
  like: () => t("screens.feed.toast.like"),
  save: () => t("screens.feed.toast.save"),
  not_interested: () => t("screens.feed.toast.notInterested"),
  hide_source: (p) =>
    t("screens.feed.toast.hideSource", {
      source: primarySource(p) ?? t("screens.feed.thisSource"),
    }),
  follow_topic: (p) =>
    t("screens.feed.toast.followTopic", { topic: feedTopic(p) ?? t("screens.feed.thisTopic") }),
};

/** Connected Feed: `feed.list`, `feed.feedback` (optimistic, with an undo toast). */
export function FeedScreen({
  onAsk,
  onEditInstructions,
  instructionsOpen,
  onCloseInstructions,
  onSchedule,
  onGenerate,
  sourceFailures,
  now: fixedNow,
}: FeedScreenProps): ReactElement {
  const { navigate } = useSlots();
  const persona = usePersona();
  const feed = useFeed();
  const { settings } = useSettings();
  const now = useNow(60_000, fixedNow);
  const [generating, setGenerating] = useState(false);

  const giveFeedback = (post: FeedPost, value: FeedFeedbackValue | null, topic?: string) => {
    feed.feedback(post.id, value, topic).catch((err: unknown) => {
      toast.error(t("screens.feed.feedbackFailed", { reason: describeError(err) }));
    });
    if (value === null) return;
    toast(FEEDBACK_TOAST[value](post), {
      id: `feed-feedback-${post.id}`,
      action: {
        label: t("screens.feed.undo"),
        onClick: () => {
          void feed.feedback(post.id, null).catch(() => {});
        },
      },
    });
  };

  const generate = () => {
    setGenerating(true);
    Promise.resolve(onGenerate ? onGenerate() : feed.generate())
      .catch((err: unknown) => {
        toast.error(t("screens.feed.generateFailed", { reason: describeError(err) }));
      })
      .finally(() => setGenerating(false));
  };

  // The sheet opens at once and the route follows, so it works with or without a router.
  const [ownOpen, setOwnOpen] = useState(false);
  const editorOpen = instructionsOpen ?? ownOpen;
  const editInstructions =
    onEditInstructions ??
    (() => {
      setOwnOpen(true);
      navigate?.("/feed/instructions");
    });
  const closeInstructions = () => {
    setOwnOpen(false);
    if (onCloseInstructions) onCloseInstructions();
    else if (instructionsOpen !== undefined) navigate?.("/feed");
  };
  const schedule = onSchedule ?? (() => navigate?.("/overview#upcoming"));

  return (
    <>
      <FeedView
        posts={feed.posts}
        nextBriefAt={feed.nextBriefAt}
        loading={feed.posts.length === 0 && feed.loading}
        loadingDelayMs={150}
        error={feed.posts.length === 0 ? feed.error : null}
        onRetry={feed.reload}
        generating={generating}
        persona={persona.name}
        onFeedback={giveFeedback}
        onEditInstructions={editInstructions}
        onSchedule={schedule}
        onGenerate={generate}
        onOpenRoute={(route) => navigate?.(route)}
        {...(settings["specialists.showInFeed"] === true
          ? { specialistResults: <FeedSpecialistResults now={now} /> }
          : {})}
        {...(onAsk ? { onAsk } : {})}
        {...(sourceFailures ? { sourceFailures } : {})}
      />
      {onEditInstructions ? null : (
        <FeedInstructionsSheet
          open={editorOpen}
          onClose={closeInstructions}
          onSchedule={() => {
            setOwnOpen(false);
            schedule();
          }}
          onGenerate={() => (onGenerate ? onGenerate() : feed.generate())}
        />
      )}
    </>
  );
}
