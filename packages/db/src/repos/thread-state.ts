import { eq } from "drizzle-orm";
import { decodeJson } from "../mappers.ts";
import type { PsycheDb } from "../open.ts";
import { agentThreadState } from "../schema.ts";

/** The stored agent state of a thread (any JSON object), or `undefined`. */
export function getAgentThreadState(
  db: PsycheDb,
  threadId: string,
): Record<string, unknown> | undefined {
  const row = db.drizzle
    .select()
    .from(agentThreadState)
    .where(eq(agentThreadState.threadId, threadId))
    .get();
  return row === undefined ? undefined : decodeJson<Record<string, unknown>>(row.state);
}

export function putAgentThreadState(
  db: PsycheDb,
  threadId: string,
  state: Record<string, unknown>,
): void {
  const at = db.now();
  const json = JSON.stringify(state);
  db.drizzle
    .insert(agentThreadState)
    .values({ threadId, state: json, createdAt: at, updatedAt: at })
    .onConflictDoUpdate({ target: agentThreadState.threadId, set: { state: json, updatedAt: at } })
    .run();
}

export function deleteAgentThreadState(db: PsycheDb, threadId: string): boolean {
  return (
    db.drizzle.delete(agentThreadState).where(eq(agentThreadState.threadId, threadId)).run()
      .changes > 0
  );
}
