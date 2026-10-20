import type { ComposeServices } from "./services.ts";

/**
 * The origins a `web_fetch` call's Task may read, for its per-hop redirect check (#72; security
 * §6, I7). Tasks have no stored origin set yet (docs/status/s05.md), so the set is what the
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
