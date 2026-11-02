import { ChatThread, t, useStoreState, useThread } from "@psyche/ui";
import { type ReactElement, useEffect, useRef } from "react";

/**
 * A side chat in the pane beside the view (⌘L on a search result). A slim line names where it came
 * from and offers the full-screen chat; the pane's own tab and × close it, and the chat stays in
 * the thread list, linked to its parent.
 */
export function SideChatPane({
  threadId,
  onExpand,
}: {
  threadId: string;
  /** Opens this chat full screen (and the caller closes the pane). */
  onExpand: () => void;
}): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  // The chat on screen has the focus when the pane opens; the owner opened this one to ask in it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per side chat shown
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      root.current?.querySelector<HTMLElement>("[data-composer-input]")?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [threadId]);
  const thread = useThread(threadId).thread?.thread;
  const parentId = thread?.parentThreadId ?? null;
  const parent = useStoreState((s) => (parentId === null ? undefined : s.threads[parentId]));
  const from = parent
    ? parent.thread.kind === "main"
      ? t("web.threads.mainChat")
      : parent.thread.title || t("web.threads.sideChat")
    : null;
  return (
    <div ref={root} className="absolute inset-0 flex min-h-0 flex-col" data-testid="side-chat-pane">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-separator px-3 text-subheadline text-label-secondary">
        <span className="min-w-0 flex-1 truncate" data-testid="side-chat-from">
          {from === null ? t("web.sideChat.aside") : t("web.sideChat.about", { parent: from })}
        </span>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-label-secondary hover:bg-fill-tertiary hover:text-label-primary"
          onClick={onExpand}
          title={t("web.sideChat.expandTitle")}
        >
          <span aria-hidden="true">⤢</span>
          {t("web.sideChat.expand")}
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatThread threadId={threadId} />
      </div>
    </div>
  );
}
