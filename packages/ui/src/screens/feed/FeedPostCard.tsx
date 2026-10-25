import type { FeedPost } from "@psyche/protocol";
import { Bookmark, Ellipsis, EyeOff, Heart, MessageCircle, Plus, ThumbsDown } from "lucide-react";
import { type ReactElement, useId } from "react";
import { Markdown } from "../../blocks/Markdown.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import { t } from "../../i18n/core.ts";
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
 * markers, then one footer row: the sources (count, letter badges and names) on the left and the
 * feedback on the right. Like, Save and Ask are ghost icon buttons; Follow topic, Not interested
 * and Hide source sit under ⋯.
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
  const liked = post.feedback === "like";
  const saved = post.feedback === "save";

  return (
    <article
      aria-labelledby={titleId}
      data-kind={kind}
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-gray-6 bg-gray-2 px-5 py-4 psy-enter",
        post.exploration ? "border-dashed" : "",
        className,
      )}
    >
      <p className="text-label text-gray-11">
        <span className={cn(kind === "exploration" ? "text-accent-11" : "")}>
          {feedKindLabel(post)}
        </span>
        {kind === "briefing" ? <span> · {formatTime(post.createdAt)}</span> : null}
      </p>
      <h2 id={titleId} className="text-h3 text-foreground">
        {post.title}
      </h2>
      {/* Every [n] marker reads the same: web citations are links, in-app ones plain text. */}
      <Markdown className="text-reading text-gray-12 [&_a]:text-inherit [&_a]:underline [&_a]:decoration-dotted [&_a]:underline-offset-2 [&_a:hover]:decoration-solid [&_a]:rounded-sm [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-ring">
        {withCitationLinks(post.bodyMd, post.citations)}
      </Markdown>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
        {sources.length > 0 ? (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-callout text-gray-11">
            <span className="font-medium">
              {t("screens.feed.sourcesCount", { n: post.citations.length })}
            </span>
            <ul
              aria-label={t("screens.feed.sources")}
              className="flex flex-wrap items-center gap-x-2 gap-y-1"
            >
              {sources.map((s) => (
                <li key={s.name}>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 rounded-full hover:text-gray-12 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
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
        ) : (
          <span className="flex-1" />
        )}

        <fieldset className="m-0 -me-2 flex min-w-0 items-center gap-0.5 border-0 p-0">
          <legend className="sr-only">{t("screens.feed.feedbackOn", { title: post.title })}</legend>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t("screens.feed.like")}
            title={t("screens.feed.like")}
            aria-pressed={liked}
            onClick={() => toggle("like")}
            className={cn("text-gray-11", liked ? "text-accent-11" : "")}
          >
            <Heart aria-hidden="true" className={liked ? "fill-current" : ""} />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t("common.save")}
            title={t("common.save")}
            aria-pressed={saved}
            onClick={() => toggle("save")}
            className={cn("text-gray-11", saved ? "text-accent-11" : "")}
          >
            <Bookmark aria-hidden="true" className={saved ? "fill-current" : ""} />
          </Button>
          {onAsk ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t("screens.feed.ask", { name: persona })}
              title={t("screens.feed.ask", { name: persona })}
              onClick={() => onAsk(post)}
              className="text-gray-11"
            >
              <MessageCircle aria-hidden="true" />
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("screens.feed.moreFeedback", { title: post.title })}
                  title={t("common.more")}
                  className="text-gray-11"
                />
              }
            >
              <Ellipsis aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuCheckboxItem
                checked={post.feedback === "follow_topic"}
                onCheckedChange={() => toggle("follow_topic", topic ?? undefined)}
              >
                <Plus aria-hidden="true" />
                {topic ? t("screens.feed.follow", { topic }) : t("screens.feed.followTopic")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuItem onClick={() => onFeedback?.(post, "not_interested")}>
                <ThumbsDown aria-hidden="true" />
                {t("screens.feed.notInterested")}
              </DropdownMenuItem>
              {hideTarget ? (
                <DropdownMenuItem onClick={() => onFeedback?.(post, "hide_source")}>
                  <EyeOff aria-hidden="true" />
                  {t("screens.feed.hide", { source: hideTarget })}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </fieldset>
      </div>
    </article>
  );
}
