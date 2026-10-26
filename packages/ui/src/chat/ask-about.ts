import type { FeedPost } from "@psyche/protocol";
import { toast } from "sonner";
import { useThreads } from "../data/hooks.ts";
import { useStore } from "../data/provider.tsx";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { feedSources } from "../screens/feed/feed-post.ts";
import { useSlots } from "../slots.tsx";

/**
 * "Ask about this" on a Feed item: a new chat named for the article, opened with the item as the
 * composer's context chip. The Gateway reads the item itself on send (`chat.send.context`), so
 * only the id travels; the title and source here are for the chip and the optimistic card.
 * Undefined when nothing can open a chat (a detached window, a bare story).
 */
export function useAskAboutFeedItem(): ((post: FeedPost) => void) | undefined {
  const store = useStore();
  const threads = useThreads();
  const { navigate } = useSlots();
  if (!navigate || store.detached) return undefined;
  return (post) => {
    threads
      .create({
        kind: "side",
        title: post.title.trim().slice(0, 200) || t("screens.feed.askAbout"),
      })
      .then((thread) => {
        const first = post.citations[0];
        store.update((s) => ({
          ...s,
          composerContext: {
            threadId: thread.id,
            ref: { kind: "feed_item", id: post.id },
            title: post.title.trim().slice(0, 300),
            source: feedSources(post)[0]?.name ?? null,
            url: first?.url ?? null,
          },
        }));
        navigate(`/chat/${thread.id}`);
      })
      .catch((err: unknown) => {
        toast.error(t("screens.feed.askFailed", { reason: describeError(err) }));
      });
  };
}
