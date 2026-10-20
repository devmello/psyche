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
import { formatTime, plural } from "../../lib/format.ts";
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
      <LoadingCards label="Loading the feed" count={3} lines={3} />
    ) : (
      <div aria-busy="true" className="min-h-24" />
    );
  } else if (error !== null) {
    body = (
      <ErrorState
        what="Psyche couldn't load the feed"
        reason={error}
        did="Your posts and feedback are safe on the Gateway."
        {...(onRetry ? { retry: { onClick: onRetry } } : {})}
      />
    );
  } else if (generating && posts.length === 0) {
    body = (
      <div className="flex flex-col gap-3">
        <p role="status" className="flex items-center gap-2 text-sm text-gray-11">
          <Loader className="size-4 text-accent-11 motion-safe:animate-spin" aria-hidden="true" />
          Writing your first brief. It lands here when it's ready.
        </p>
        <LoadingCards label="Generating the brief" count={2} lines={3} />
      </div>
    );
  } else if (posts.length === 0) {
    body = (
      <EmptyState
        icon={Newspaper}
        {...(onGenerate
          ? { action: { label: "Generate the first brief", onClick: onGenerate } }
          : {})}
      >
        No brief yet. Generate the first one, or wait until {nextAt ?? "07:00"}.
      </EmptyState>
    );
  } else {
    body = (
      <>
        <ul aria-label="Posts" className="flex flex-col gap-4">
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
            That's it for today.{nextAt ? ` Next brief ${nextAt}.` : ""}
          </p>
          <span aria-hidden="true" className="h-px flex-1 bg-gray-6" />
        </div>
      </>
    );
  }

  return (
    <section aria-label="Feed">
      <Page width="prose">
        <PageHeader
          title="Feed"
          meta={settled && posts.length > 0 ? `Today · ${plural(posts.length, "post")}` : "Today"}
          actions={
            <>
              {onEditInstructions ? (
                <Button type="button" size="sm" variant="outline" onClick={onEditInstructions}>
                  <PenLine aria-hidden="true" />
                  What should I write about
                </Button>
              ) : null}
              {onSchedule ? (
                <Button type="button" size="sm" variant="ghost" onClick={onSchedule}>
                  <CalendarClock aria-hidden="true" />
                  Schedule
                </Button>
              ) : null}
            </>
          }
        />
        {settled && sourceFailures.length > 0 ? (
          <ul aria-label="Sources this brief skipped" className="flex flex-col gap-1">
            {sourceFailures.map((f) => (
              <li
                key={f.source}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-6 bg-gray-2 px-3 py-2 text-sm"
              >
                <CircleAlert className="size-4 shrink-0 text-approval-text" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  {f.source} wasn't read ({f.reason}). Psyche left it out of this brief.
                </span>
                {f.route !== undefined && onOpenRoute ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => onOpenRoute(f.route ?? "")}
                    aria-label={`Fix ${f.source}`}
                  >
                    Fix
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
  like: () => "Liked. You'll see more like this.",
  save: () => "Saved.",
  not_interested: () => "Hidden. You'll see less like this.",
  hide_source: (p) => `Hidden posts from ${primarySource(p) ?? "this source"}.`,
  follow_topic: (p) => `Following ${feedTopic(p) ?? "this topic"}.`,
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
      toast.error(
        `Psyche couldn't save that feedback (${err instanceof Error ? err.message : String(err)}). Nothing was changed.`,
      );
    });
    if (value === null) return;
    toast(FEEDBACK_TOAST[value](post), {
      id: `feed-feedback-${post.id}`,
      action: {
        label: "Undo",
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
        toast.error(
          `Psyche couldn't write the brief (${err instanceof Error ? err.message : String(err)}). Try again, or wait for the scheduled one.`,
        );
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
