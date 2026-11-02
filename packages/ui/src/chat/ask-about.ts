import type { FeedPost, SearchHit, Thread } from "@psyche/protocol";
import { toast } from "sonner";
import { useThreads } from "../data/hooks.ts";
import { useStore } from "../data/provider.tsx";
import type { ComposerContext } from "../data/state.ts";
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

/** The chat a search result lives in: a thread result, or a message inside one. */
export function hitThreadId(hit: SearchHit): string | null {
  if (hit.scope !== "threads" && hit.scope !== "messages") return null;
  return hit.threadId ?? /^\/chat\/([^/?#]+)/.exec(hit.route ?? "")?.[1] ?? null;
}

/**
 * What the new chat is called in the thread list: "About Dentist booking", so it never reads as a
 * second copy of the result it is about.
 */
export function sideChatTitle(hit: SearchHit): string {
  const title = hit.title.trim() || t(`screens.search.scope.${hit.scope}`);
  return t("chat.sideChat.title", { title }).slice(0, 200);
}

/** What the search result shows, as the context chip and the `chat.send.context` that follow it. */
export function sideChatContext(threadId: string, hit: SearchHit): ComposerContext {
  const scope = t(`screens.search.scope.${hit.scope}`);
  return {
    threadId,
    ref: {
      kind: "search_hit",
      id: hit.id,
      title: hit.title.trim().slice(0, 300) || scope,
      ...(hit.snippet.trim() === "" ? {} : { snippet: hit.snippet.trim().slice(0, 2000) }),
      scope,
      ...(hit.route == null ? {} : { route: hit.route.slice(0, 2000) }),
      ...(hit.provenance === "untrusted" ? { untrusted: true } : {}),
    },
    title: hit.title.trim().slice(0, 300) || scope,
    source: scope,
    url: null,
  };
}

/**
 * A new side chat about a search result: named for it, linked to the chat it came from (the result
 * itself when it is a chat, else the chat that was open), with the result waiting in the composer
 * as context. Resolves with the thread; the caller decides where to show it.
 */
export async function createSideChatAbout(
  store: ReturnType<typeof useStore>,
  create: ReturnType<typeof useThreads>["create"],
  hit: SearchHit,
  openChatId: string | null,
): Promise<Thread> {
  const parent = hitThreadId(hit) ?? openChatId;
  const context = sideChatContext("", hit);
  const thread = await create({
    kind: "side",
    title: sideChatTitle(hit),
    ...(parent === null ? {} : { parentThreadId: parent }),
  });
  store.update((s) => ({ ...s, composerContext: { ...context, threadId: thread.id } }));
  return thread;
}

/**
 * "Open in a side chat" on a search result: the shell's pane beside the view where there is one,
 * else the chat full screen. Undefined where nothing can open a chat.
 */
export function useOpenInSideChat(): ((hit: SearchHit) => void) | undefined {
  const store = useStore();
  const threads = useThreads();
  const { navigate, openSideChat } = useSlots();
  if (openSideChat) return openSideChat;
  if (!navigate || store.detached) return undefined;
  return (hit) => {
    createSideChatAbout(store, threads.create, hit, null)
      .then((thread) => navigate(`/chat/${thread.id}`))
      .catch((err: unknown) => {
        toast.error(t("screens.search.sideChatFailed", { reason: describeError(err) }));
      });
  };
}
