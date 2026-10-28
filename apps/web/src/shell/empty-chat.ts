import { isComposerBusy, isEmptyUserChat } from "@psyche/ui";
import { useEffect, useRef } from "react";
import type { ShellStore } from "./store.ts";

/**
 * Asks the Gateway to delete `threadId` if it is an empty "New chat" the owner is not typing in.
 * The Gateway decides again (a message, a run or a pin that landed since keeps the thread), and
 * its sweep catches whatever a closing window could not say.
 */
export function discardIfEmpty(store: ShellStore, threadId: string): void {
  const entry = store.getState().threads.find((x) => x.thread.id === threadId);
  if (entry === undefined || !isEmptyUserChat(entry) || isComposerBusy(threadId)) return;
  void store.call("threads.discardEmpty", { threadId }).catch(() => undefined);
}

/**
 * Leaving an empty "New chat" deletes it: opening another chat or a screen (`openChatId` changes),
 * or closing the window. `openChatId` is the chat on screen, null on any other screen.
 */
export function useDiscardEmptyChat(store: ShellStore, openChatId: string | null): void {
  const latest = useRef(openChatId);
  latest.current = openChatId;
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    if (openChatId === null) return;
    // A remount on the same chat (React strict mode, a route redraw) is not leaving it.
    clearTimeout(pending.current.get(openChatId));
    pending.current.delete(openChatId);
    return () => {
      pending.current.set(
        openChatId,
        setTimeout(() => {
          pending.current.delete(openChatId);
          if (latest.current !== openChatId) discardIfEmpty(store, openChatId);
        }, 0),
      );
    };
  }, [store, openChatId]);
  useEffect(() => {
    const onHide = () => {
      if (latest.current !== null) discardIfEmpty(store, latest.current);
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [store]);
}
