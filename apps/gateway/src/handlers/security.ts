import { type MethodResult, PsycheError } from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import { requireFreshPresence } from "../presence-gate.ts";

/**
 * `security.*` (docs/design/security-state-integrity-2026.md §7.3): the seal's state, its alerts
 * and the local recovery requests. Acknowledging an alert and approving a recovery now need fresh
 * presence once a verifier is enrolled; while the records are untrusted neither works (presence
 * fails closed), so the untrusted alert stays until a re-seal. Cancelling only narrows.
 */

function parts(call: Call) {
  const seal = call.ctx.securityState;
  const recoveries = call.ctx.securityRecoveries;
  if (seal === undefined || recoveries === undefined) {
    throw new PsycheError("unavailable", "This Gateway does not seal its security state");
  }
  return { seal, recoveries };
}

export const securityHandlers: Record<string, HandlerDef> = {
  "security.state.get": {
    run(call: Call): MethodResult<"security.state.get"> {
      const seal = call.ctx.securityState;
      if (seal === undefined) return { status: "sealed", reason: null, alerts: [], recoveries: [] };
      const s = seal.status();
      return {
        status: s.status,
        reason: s.reason,
        alerts: seal.alerts.list(),
        recoveries: call.ctx.securityRecoveries?.list() ?? [],
      };
    },
  },
  "security.alerts.acknowledge": {
    async run(
      call: Call,
      params: { id: string; approvalId?: string },
    ): Promise<MethodResult<"security.alerts.acknowledge">> {
      const { seal } = parts(call);
      const alert = seal.alerts.get(params.id);
      if (alert === undefined) throw new PsycheError("not_found", `no alert ${params.id}`);
      if (alert.acknowledgedAt !== null) return { alert };
      await requireFreshPresence(
        call,
        {
          name: "method:security.alerts.acknowledge",
          summary: "Mark a security alert reviewed",
          subject: { id: alert.id, kind: alert.kind },
          details: { method: "security.alerts.acknowledge", id: alert.id, kind: alert.kind },
        },
        params.approvalId,
      );
      const done = seal.alerts.acknowledge(alert.id, call.identity.deviceId);
      seal.changed();
      return { alert: done ?? alert };
    },
  },
  "security.recoveries.cancel": {
    run(call: Call, params: { id: string }): MethodResult<"security.recoveries.cancel"> {
      const { recoveries } = parts(call);
      // `identity.scopes` are what the seal still trusts this device with (untrusted: narrowed).
      return {
        recovery: recoveries.cancel(params.id, call.identity.deviceId, {
          trustedAdmin: call.identity.scopes.includes("operator.admin"),
        }),
      };
    },
  },
  "security.recoveries.approve": {
    async run(
      call: Call,
      params: { id: string; approvalId?: string },
    ): Promise<MethodResult<"security.recoveries.approve">> {
      const { recoveries } = parts(call);
      const subject = recoveries.subject(params.id);
      if (subject.op === "seal.reset") {
        throw new PsycheError(
          "forbidden",
          "A re-seal always waits: no Touch ID key or passkey can be trusted while the records are untrusted",
        );
      }
      await requireFreshPresence(
        call,
        {
          name: "method:security.recoveries.approve",
          summary: "Apply a security change asked for on the Mac now",
          subject: { id: subject.id, op: subject.op, params: subject.params },
          // The card names what it approves: the device, its key and the scopes.
          details: {
            method: "security.recoveries.approve",
            id: subject.id,
            op: subject.op,
            ...subject.card,
          },
        },
        params.approvalId,
      );
      return { recovery: recoveries.approveNow(params.id, call.identity.deviceId) };
    },
  },
};
