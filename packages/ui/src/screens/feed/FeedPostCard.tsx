import type { FeedPost } from "@psyche/protocol";
import { Bookmark, EyeOff, Heart, MessageCircle, Plus, ThumbsDown } from "lucide-react";
import { type ReactElement, useId } from "react";
import { Markdown } from "../../blocks/Markdown.tsx";
import { Button } from "../../components/ui/button.tsx";
import { formatTime } from "../../lib/format.ts";
import { cn } from "../../lib/utils.ts";
import {
  feedKind,
  feedKindLabel,
  feedSources,
  feedTopic,
  primarySource,
  withCitationLinks,
} from "./feed-post.ts";

export type FeedFeedbackValue = NonNullable<FeedPost["feedback"]>;

export interface FeedPostCardProps {
  post: FeedPost;
  /** Persona name for "Ask Wren". */
  persona?: string;
  /** Records feedback; `null` clears it. The topic travels with follow_topic. */
  onFeedback?: (post: FeedPost, feedback: FeedFeedbackValue | null, topic?: string) => void;
  onAsk?: (post: FeedPost) => void;
  className?: string;
}

/**
 * Feed post card (UI design §3.9). Fixed element order: kind label, title, body with citation
 * markers, source row (count, letter badges and names), feedback row, Ask.
 */
export function FeedPostCard({
  post,
  persona = "Wren",
  onFeedback,
  onAsk,
  className,
}: FeedPostCardProps): ReactElement {
  const titleId = useId();
  const sources = feedSources(post);
  const topic = feedTopic(post);
  const hideTarget = primarySource(post);
  const kind = feedKind(post);
  const toggle = (value: FeedFeedbackValue, withTopic?: string) =>
    onFeedback?.(post, post.feedback === value ? null : value, withTopic);

  return (
    <article
      aria-labelledby={titleId}
      data-kind={kind}
      className={cn(
        "rounded-lg border border-gray-6 bg-gray-2 p-4 psy-enter",
        post.exploration ? "border-dashed" : "",
        className,
      )}
    >
      <p className="text-label font-semibold text-muted-foreground">
        <span className={cn(kind === "exploration" ? "text-accent-11" : "")}>
          {feedKindLabel(post)}
        </span>
        {kind === "briefing" ? <span> · {formatTime(post.createdAt)}</span> : null}
      </p>
      <h2 id={titleId} className="mt-1 text-base font-semibold">
        {post.title}
      </h2>
      <Markdown className="mt-1 text-sm text-gray-12">
        {withCitationLinks(post.bodyMd, post.citations)}
      </Markdown>

      {sources.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-11">
          <span className="font-medium">Sources ({post.citations.length})</span>
          <ul aria-label="Sources" className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {sources.map((s) => (
              <li key={s.name}>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 rounded-full hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span
                    aria-hidden="true"
                    className="inline-flex size-4 items-center justify-center rounded-full bg-gray-4 text-[10px] font-semibold text-gray-12"
                  >
                    {s.letter}
                  </span>
                  {s.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <fieldset className="m-0 mt-3 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0">
        <legend className="sr-only">Feedback on {post.title}</legend>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-pressed={post.feedback === "follow_topic"}
          onClick={() => toggle("follow_topic", topic ?? undefined)}
        >
          <Plus aria-hidden="true" />
          {topic ? `Follow: ${topic}` : "Follow topic"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onFeedback?.(post, "not_interested")}
        >
          <ThumbsDown aria-hidden="true" />
          Not interested
        </Button>
        {hideTarget ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onFeedback?.(post, "hide_source")}
          >
            <EyeOff aria-hidden="true" />
            Hide {hideTarget}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-pressed={post.feedback === "like"}
          onClick={() => toggle("like")}
          className={cn(post.feedback === "like" ? "text-accent-11" : "")}
        >
          <Heart aria-hidden="true" className={post.feedback === "like" ? "fill-current" : ""} />
          Like
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-pressed={post.feedback === "save"}
          onClick={() => toggle("save")}
          className={cn(post.feedback === "save" ? "text-accent-11" : "")}
        >
          <Bookmark aria-hidden="true" className={post.feedback === "save" ? "fill-current" : ""} />
          Save
        </Button>
        {onAsk ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => onAsk(post)}
          >
            <MessageCircle aria-hidden="true" />
            Ask {persona}
          </Button>
        ) : null}
      </fieldset>
    </article>
  );
}
