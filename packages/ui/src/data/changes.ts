import type { AuditChange } from "@psyche/protocol";
import { useGatewayQuery } from "./hooks.ts";

/**
 * The owner-data audit (`audit.changes`): what the chat's change chip and the Activity audit
 * view show. Read from the Gateway's stored, hash-chained records, so it survives reloads;
 * `audit.change.recorded` refreshes it live.
 */

export type AuditCategory = AuditChange["category"];

const NONE: readonly AuditChange[] = [];

export function useChanges(
  params: { threadId?: string; runId?: string; categories?: AuditCategory[]; limit?: number },
  options: { enabled?: boolean } = {},
) {
  const q = useGatewayQuery("audit.changes", params, options);
  return { ...q, changes: q.data?.changes ?? NONE };
}

/** One change with its stored diff, fetched when its row is opened. */
export function useChangeDiff(seq: number, enabled: boolean) {
  const q = useGatewayQuery("audit.change", { seq }, { enabled });
  return { ...q, diff: q.data?.diff };
}

/** The hash-chain status (`audit.verify`), re-checked when a change is recorded. */
export function useChainStatus() {
  const q = useGatewayQuery("audit.verify", {});
  return { ...q, status: q.data };
}
