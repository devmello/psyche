import { stubTurnContext } from "@psyche/agent-core";
import { type PsycheDb, putAgentThreadState } from "@psyche/db";
import type { ModelMessage } from "@psyche/protocol";

/**
 * Forget and retract: the Gateway cuts the context recalled for a turn out of every saved thread
 * that is not running. The agent replaces it at the start of its next run anyway; this keeps a
 * forgotten line from sitting in the database (and any backup of it) until then. A running
 * thread is left to its run, which saves its own state when it ends.
 */
export function scrubSavedRecall(db: PsycheDb, isActive: (threadId: string) => boolean): number {
  let changed = 0;
  const rows = db.sqlite.prepare("SELECT thread_id AS id, state FROM agent_thread_state").all() as {
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
