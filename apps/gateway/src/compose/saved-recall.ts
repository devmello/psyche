import { stubTurnContext } from "@psyche/agent-core";
import { type PsycheDb, putAgentThreadState } from "@psyche/db";
import type { ModelMessage } from "@psyche/protocol";

/**
 * Rows saved before a run's recall was stubbed at the run's end (the agent now saves none): the
 * Gateway cuts the context recalled for a turn out of every saved thread that is not running, on
 * Forget and retract. Only rows that carry the flag are read. A running thread is left to its run.
 */
export function scrubSavedRecall(db: PsycheDb, isActive: (threadId: string) => boolean): number {
  let changed = 0;
  const rows = db.sqlite
    .prepare(
      `SELECT thread_id AS id, state FROM agent_thread_state WHERE state LIKE '%"turnContext"%'`,
    )
    .all() as {
    id: string;
    state: string;
  }[];
  for (const row of rows) {
    if (!row.state.includes('"turnContext"') || isActive(row.id)) continue;
    let state: { messages?: ModelMessage[] };
    try {
      state = JSON.parse(row.state) as { messages?: ModelMessage[] };
    } catch {
      continue;
    }
    if (!Array.isArray(state.messages) || !stubTurnContext(state.messages)) continue;
    putAgentThreadState(db, row.id, state as Record<string, unknown>);
    changed += 1;
  }
  return changed;
}
