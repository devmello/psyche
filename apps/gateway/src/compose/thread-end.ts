import { getThread, listAllMessages, type PsycheDb } from "@psyche/db";
import { type LaneItem, ownWords } from "@psyche/memory";
import type { ThreadKind } from "@psyche/protocol";
import type { Logger } from "../log.ts";

/**
 * The listener for a conversation that ended (Clear chat, delete): it ends the broker's session
 * for the thread (its "Allow once" folders, attached files, session-scope grants, circuit
 * breaker). A failure is logged and swallowed: psyched has no unhandledRejection handler, and
 * the clear or delete has already happened.
 */
export function endSessionQuietly(
  broker: { endSession(threadId: string): Promise<unknown> },
  log?: Logger,
): (threadId: string) => void {
  return (threadId) => {
    void Promise.resolve()
      .then(() => broker.endSession(threadId))
      .catch((err: unknown) => {
        log?.log("warn", "ending a conversation's grants failed", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };
}

/** One of the owner's own typed turns in a finished conversation. */
export interface EndedTurn {
  id: string;
  text: string;
  at: string;
}

/** The owner's turns of one thread, taken before Clear chat or delete removes them. */
export interface ChatSnapshot {
  kind: ThreadKind;
  turns: readonly EndedTurn[];
}

/**
 * Reads the thread from the store, synchronously. Only a message the owner typed counts: role
 * `user`, provenance `owner`, and no `channelRef` (a Telegram or iMessage turn arrives through a
 * channel, and anything an app or a person forwards is not the owner's typing).
 */
export function snapshotThread(db: PsycheDb, threadId: string): ChatSnapshot | undefined {
  const thread = getThread(db, threadId);
  if (thread === undefined) return undefined;
  const turns: EndedTurn[] = [];
  for (const m of listAllMessages(db, threadId)) {
    if (m.role !== "user" || m.provenance !== "owner" || m.channelRef !== null) continue;
    const text = m.blocks.map((b) => (b.type === "text" ? b.md : "")).join("\n");
    turns.push({ id: m.id, text, at: m.createdAt });
  }
  return { kind: thread.kind, turns };
}

export interface PromiseChatDeps {
  /** `promises.enabled`, `promises.sources.chat` and the owner's consent, all read now. */
  enabled: () => boolean;
  /** Synchronous: the thread's turns as they are right now. `snapshotThread` over the real store. */
  snapshot: (threadId: string) => ChatSnapshot | undefined;
  /** `runPromiseLane` with the lane's dependencies bound. */
  run: (items: LaneItem[]) => Promise<unknown>;
  log?: Logger;
}

const MAX_CHAT_TURNS = 30;
/** A longer turn is most likely a pasted mail or document, not the owner's own words. */
const MAX_CHAT_TURN_CHARS = 2_000;
/** Snapshots held at once (a thread that never reports `ended` cannot grow this). */
const MAX_PENDING = 50;
/** Only the owner's own conversations: never a channel, automation, subagent or incognito thread. */
const READABLE_KINDS: ReadonlySet<ThreadKind> = new Set(["main", "side"]);

/** The owner's own words in a turn: no quoted lines, no fenced blocks, no pasted paragraphs. */
export function ownChatText(text: string): string {
  const stripped = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .split(/\r?\n/)
    .filter((l) => !/^\s*>/.test(l))
    .join("\n");
  return (
    ownWords(stripped)
      // `ownWords` marks each removed block with U+0001.
      .split(String.fromCharCode(1))
      .join(" ")
      .replace(/[ \t]+/g, " ")
      .trim()
  );
}

/**
 * Chat feeds the promise lane at thread end (design 3.2 step 3), in two steps. `ending` runs just
 * before the messages are deleted (register it on `ctx.threadEnding`) and takes the snapshot;
 * `ended` runs after (`ctx.threadEnded`) and hands it to the lane. Only main and side threads are
 * read, and only the owner's typed turns, cut to their own words. Like `endSessionQuietly`,
 * failures are logged and swallowed: psyched has no unhandledRejection handler, and the clear or
 * delete has already happened.
 */
export function promiseChatOnThreadEnd(deps: PromiseChatDeps): {
  ending: (threadId: string) => void;
  ended: (threadId: string) => void;
} {
  const pending = new Map<string, ChatSnapshot>();
  return {
    ending: (threadId) => {
      try {
        if (!deps.enabled()) return;
        const snap = deps.snapshot(threadId);
        if (snap === undefined || !READABLE_KINDS.has(snap.kind)) return;
        if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string);
        pending.set(threadId, snap);
      } catch (err) {
        deps.log?.log("warn", "reading a conversation for promises failed", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    ended: (threadId) => {
      const snap = pending.get(threadId);
      pending.delete(threadId);
      if (snap === undefined) return;
      void Promise.resolve()
        .then(async () => {
          const items: LaneItem[] = [];
          for (const turn of snap.turns.slice(-MAX_CHAT_TURNS)) {
            if (turn.text.length > MAX_CHAT_TURN_CHARS) continue;
            const text = ownChatText(turn.text);
            if (text === "") continue;
            items.push({
              source: "chat",
              sourceRef: `chat:${threadId}:${turn.id}`,
              threadId,
              author: "owner",
              counterpartId: null,
              counterpartLabel: null,
              sentAt: turn.at,
              text,
            });
          }
          if (items.length > 0) await deps.run(items);
        })
        .catch((err: unknown) => {
          deps.log?.log("warn", "reading a finished conversation for promises failed", {
            threadId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    },
  };
}
