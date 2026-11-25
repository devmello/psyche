import type { LaneItem } from "@psyche/memory";
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

/** One turn of a finished conversation, as the promise lane needs it. */
export interface EndedTurn {
  id: string;
  role: string;
  text: string;
  at: string;
}

export interface PromiseChatDeps {
  /** `promises.enabled`, `promises.sources.chat` and the owner's consent, all read now. */
  enabled: () => boolean;
  /** The ended thread's turns; `undefined` when it is gone. `incognito` threads are never read. */
  readThread: (
    threadId: string,
  ) => Promise<{ incognito: boolean; turns: readonly EndedTurn[] } | undefined>;
  /** `runPromiseLane` with the lane's dependencies bound. */
  run: (items: LaneItem[]) => Promise<unknown>;
  log?: Logger;
}

const MAX_CHAT_TURNS = 30;
/** A longer turn is most likely a pasted mail or document, not the owner's own words. */
const MAX_CHAT_TURN_CHARS = 2_000;

/** The owner's own words in a turn: no quoted lines, no fenced blocks. */
function ownChatText(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .split(/\r?\n/)
    .filter((l) => !/^\s*>/.test(l))
    .join("\n")
    .trim();
}

/**
 * Chat feeds the promise lane at thread end (design 3.2 step 3). Only the owner's own turns are
 * read: never the assistant's, a tool's, an incognito thread's, or a long pasted block. Like
 * `endSessionQuietly`, a failure is logged and swallowed: psyched has no unhandledRejection
 * handler, and the clear or delete has already happened.
 */
export function promiseChatOnThreadEnd(deps: PromiseChatDeps): (threadId: string) => void {
  return (threadId) => {
    void Promise.resolve()
      .then(async () => {
        if (!deps.enabled()) return;
        const thread = await deps.readThread(threadId);
        if (thread === undefined || thread.incognito) return;
        const items: LaneItem[] = [];
        for (const turn of thread.turns.filter((t) => t.role === "user").slice(-MAX_CHAT_TURNS)) {
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
  };
}
