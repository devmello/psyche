import { useSyncExternalStore } from "react";

/**
 * A one-shot ask to land on a message when a thread opens: the Library's "Open in chat" on an
 * artifact sets it, then navigates to the thread. The thread scrolls to the message, flashes it
 * and (when `artifactId` is set) opens the artifact in the canvas. The route stays a plain
 * `/chat/<id>`, so every shell that can open a thread can honour it.
 */
export interface ChatFocusRequest {
  threadId: string;
  /** The message to scroll to; null when the artifact's message is not known yet. */
  messageId: string | null;
  artifactId: string | null;
}

let pending: ChatFocusRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function requestChatFocus(request: ChatFocusRequest): void {
  pending = request;
  emit();
}

export function clearChatFocus(request: ChatFocusRequest): void {
  if (pending !== request) return;
  pending = null;
  emit();
}

/** The request waiting for `threadId`, or null. */
export function useChatFocusRequest(threadId: string): ChatFocusRequest | null {
  const current = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => pending,
    () => null,
  );
  return current?.threadId === threadId ? current : null;
}

/** How long a landed-on message stays highlighted. */
export const CHAT_FOCUS_FLASH_MS = 1800;

/** Scrolls to `message-<id>` and flashes it; false when it is not rendered. */
export function flashMessage(messageId: string, root: Document = document): boolean {
  const el = root.getElementById(`message-${messageId}`);
  if (el === null) return false;
  el.scrollIntoView({ block: "center" });
  // The thread pins itself to the bottom as it settles; scroll again once it has.
  requestAnimationFrame(() => el.scrollIntoView({ block: "center" }));
  el.setAttribute("data-flash", "true");
  setTimeout(() => el.removeAttribute("data-flash"), CHAT_FOCUS_FLASH_MS);
  return true;
}

/** The request waiting, whatever its thread (tests). */
export function getChatFocusRequestForTest(): ChatFocusRequest | null {
  return pending;
}
