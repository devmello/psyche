import type { Message } from "@psyche/protocol";
import type { FixtureWorld } from "./index.ts";

/**
 * Appends `count` alternating user / agent messages to a thread, for checking that a long
 * conversation scrolls inside the chat viewport instead of growing the window (#548).
 */
export function addLongConversation(world: FixtureWorld, threadId: string, count = 50): void {
  const existing = world.messages.filter((m) => m.threadId === threadId);
  const seq0 = existing.reduce((max, m) => Math.max(max, m.seq), -1) + 1;
  const start = Date.parse("2026-10-19T08:00:00Z");
  for (let i = 0; i < count; i++) {
    const user = i % 2 === 0;
    const message: Message = {
      id: `msg_long_${threadId}_${i}`,
      threadId,
      seq: seq0 + i,
      role: user ? "user" : "agent",
      blocks: [
        {
          type: "text",
          md: user
            ? `Question ${i / 2 + 1}: what's next on the list?`
            : `Answer ${(i + 1) / 2}: the next item is ready. It has a few details worth reading, so this reply runs to two lines in a narrow column.`,
        },
      ],
      providerNative: null,
      provenance: user ? "owner" : "agent",
      replyToMessageId: null,
      channelRef: null,
      runId: null,
      createdAt: new Date(start + i * 60_000).toISOString(),
    };
    world.messages.push(message);
  }
}
