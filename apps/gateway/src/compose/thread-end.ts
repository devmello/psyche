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
