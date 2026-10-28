import type { ThreadListEntry } from "@psyche/protocol";

/**
 * A chat the owner opened with "New chat" that has no message yet. The thread list never shows
 * one, New chat goes back to it instead of making another, and leaving it deletes it. A pinned
 * one is the owner's keep, and a thread another feature made (task, channel, fork, "Ask about")
 * never carries `userCreated`.
 */
export function isEmptyUserChat(entry: ThreadListEntry): boolean {
  const { thread } = entry;
  return (
    thread.userCreated === true &&
    !thread.pinned &&
    thread.lastMessageAt == null &&
    entry.lastMessage === undefined
  );
}
