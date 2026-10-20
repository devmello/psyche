import type { FeedPost } from "@psyche/protocol";
import { CalendarClock, CircleAlert, Loader, Newspaper, PenLine } from "lucide-react";
import { type ReactElement, useState } from "react";
import { toast } from "sonner";
import {
  EmptyState,
  ErrorState,
  LoadingCards,
  Page,
  PageHeader,
  useDelayedFlag,
} from "../../components/page.tsx";
import { Button } from "../../components/ui/button.tsx";
import { useFeed } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { formatTime } from "../../lib/format.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import { type FeedFeedbackValue, FeedPostCard } from "./FeedPostCard.tsx";
import { feedTopic, primarySource } from "./feed-post.ts";

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
}: FeedViewProps): ReactElement {
  const nextAt = nextBriefAt === null ? null : formatTime(nextBriefAt);
  const settled = !loading && error === null;
  const showSkeleton = useDelayedFlag(loading, loadingDelayMs);

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
        <p role="status" className="flex items-center gap-2 text-sm text-gray-11">
          <Loader className="size-4 text-accent-11 motion-safe:animate-spin" aria-hidden="true" />
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
        <ul aria-label={t("screens.feed.posts")} className="flex flex-col gap-4">
          {posts.map((post) => (
            <li key={post.id}>
              <FeedPostCard
                post={post}
                persona={persona}
                {...(onFeedback ? { onFeedback } : {})}
                {...(onAsk ? { onAsk } : {})}
              />
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-3 py-4">
          <span aria-hidden="true" className="h-px flex-1 bg-gray-6" />
          <p className="text-small text-gray-11">
            {t("screens.feed.end", { next: nextAt ?? "", hasNext: Boolean(nextAt) })}
          </p>
          <span aria-hidden="true" className="h-px flex-1 bg-gray-6" />
        </div>
      </>
    );
  }

  return (
    <section aria-label={t("screens.feed.title")}>
      <Page width="prose">
        <PageHeader
          title={t("screens.feed.title")}
          meta={
            settled && posts.length > 0
              ? t("screens.feed.todayPosts", { n: posts.length })
              : t("screens.feed.today")
          }
          actions={
            <>
              {onEditInstructions ? (
                <Button type="button" size="sm" variant="outline" onClick={onEditInstructions}>
                  <PenLine aria-hidden="true" />
                  {t("screens.feed.instructions")}
                </Button>
              ) : null}
              {onSchedule ? (
                <Button type="button" size="sm" variant="ghost" onClick={onSchedule}>
                  <CalendarClock aria-hidden="true" />
                  {t("screens.feed.schedule")}
                </Button>
              ) : null}
            </>
          }
        />
        {settled && sourceFailures.length > 0 ? (
          <ul aria-label={t("screens.feed.skipped")} className="flex flex-col gap-1">
            {sourceFailures.map((f) => (
              <li
                key={f.source}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-6 bg-gray-2 px-3 py-2 text-sm"
              >
                <CircleAlert className="size-4 shrink-0 text-approval-text" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  {t("screens.feed.sourceFailed", { source: f.source, reason: f.reason })}
                </span>
                {f.route !== undefined && onOpenRoute ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
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
        {body}
      </Page>
    </section>
  );
}

export interface FeedScreenProps {
  /** Opens a side chat seeded with the post (Psyche decision, §3.9). */
  onAsk?: (post: FeedPost) => void;
  /** Defaults to navigating to `/feed/instructions`. */
  onEditInstructions?: () => void;
  /** Defaults to navigating to `/agent/upcoming`, where briefings are edited. */
  onSchedule?: () => void;
  /** Defaults to `feed.generate` through `useFeed().generate`. */
  onGenerate?: () => Promise<unknown> | undefined;
  sourceFailures?: readonly FeedSourceFailure[];
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
  onSchedule,
  onGenerate,
  sourceFailures,
}: FeedScreenProps): ReactElement {
  const { navigate } = useSlots();
  const persona = usePersona();
  const feed = useFeed();
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

  const editInstructions = onEditInstructions ?? (() => navigate?.("/feed/instructions"));
  const schedule = onSchedule ?? (() => navigate?.("/agent/upcoming"));

  return (
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
      {...(onAsk ? { onAsk } : {})}
      {...(sourceFailures ? { sourceFailures } : {})}
    />
  );
}
