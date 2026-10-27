import { PsycheError } from "@psyche/protocol";
import type { ComposeServices } from "./services.ts";

/**
 * The origins a `web_fetch` call's Task may read, for its per-hop redirect check (#72; security
 * §6, I7). Tasks have no stored origin set yet (docs/archive/status/s05.md), so the set is what the
 * owner approved: live `new_origin` grants scoped to this call's Task, plus `site` and `always`
 * grants. `session` grants are left out because the grant does not say which thread they belong
 * to, so a redirect into a session-approved origin is refused and asked as its own call.
 */
export function taskOrigins(services: Pick<ComposeServices, "broker" | "calls" | "clock">) {
  return async (run: { callId: string }): Promise<string[]> => {
    const taskId = services.calls.get(run.callId)?.taskId;
    const now = services.clock.now();
    const out = new Set<string>();
    for (const g of await services.broker.listGrants({ kind: "new_origin" })) {
      if (g.revokedAt != null) continue;
      if (g.expiresAt != null && Date.parse(g.expiresAt) <= now) continue;
      if (g.scope === "session" || g.scope === "once") continue;
      if (g.scope === "task" && (taskId === undefined || g.taskId !== taskId)) continue;
      const target = g.subject.target as { kind?: unknown; value?: unknown } | undefined;
      if (target?.kind !== "origin" || typeof target.value !== "string") continue;
      out.add(target.value);
    }
    return [...out];
  };
}

/**
 * `web_fetch` admission (security §10: 60/minute/Task, `gateway.rateLimits.fetchPerMinute`).
 * The key is the call's Task, or its thread for an interactive turn; refusals are audited by the
 * limit and fail the call `rate_limited` before any request leaves.
 */
export function fetchLimit(services: Pick<ComposeServices, "calls" | "rateLimits">) {
  return (run: { callId: string }): void => {
    const ctx = services.calls.get(run.callId);
    const thread = ctx?.threadId ?? run.callId;
    const [key, data]: [string, Record<string, string>] =
      ctx?.taskId !== undefined
        ? [`task:${ctx.taskId}`, { taskId: ctx.taskId }]
        : [`thread:${thread}`, { threadId: thread }];
    const limit = services.rateLimits.fetch;
    if (!limit.admit(key, data)) {
      throw new PsycheError(
        "rate_limited",
        `web_fetch is limited to ${limit.perMinute} requests a minute per task; wait a minute and retry`,
        { retryable: true },
      );
    }
  };
}
