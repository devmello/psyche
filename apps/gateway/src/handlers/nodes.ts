import { getNode } from "@psyche/db";
import {
  type ErrorPayload,
  type NodeEventParams,
  type NodeResultParams,
  PsycheError,
  type Receipt,
  type ToolCallIntent,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import { paramsHash } from "../idempotency.ts";

/**
 * Capability namespaces a client can never reach through `nodes.invoke`: the helper's vault and
 * keychain, and anything that changes security settings (architecture §6, §11; security §4.3,
 * §10; S23 review TODO). The agent's own node tools go through the same broker path (S02).
 */
const UNREACHABLE =
  /^(vault|keychain|settings|permissions|grants|approvals|devices|gateway)([^a-z0-9]|$)/;

export function isUnreachableCapability(name: string): boolean {
  return UNREACHABLE.test(name.toLowerCase());
}

/** Pseudo thread id for client-initiated invocations (no conversation owns them). */
export const CLIENT_INVOKE_THREAD = "client:nodes.invoke";

export const nodesHandlers: Record<string, HandlerDef> = {
  "nodes.list": {
    run: (call: Call) => ({ nodes: call.ctx.nodes.list() }),
  },
  "nodes.capabilities": {
    run(call: Call, params: { nodeId: string }) {
      const node = getNode(call.ctx.db, params.nodeId);
      if (!node) throw new PsycheError("not_found", `node ${params.nodeId} not found`);
      return { nodeId: node.id, capabilities: node.capabilities };
    },
  },
  "nodes.invoke": {
    async run(
      call: Call,
      params: { nodeId: string; capability: string; params: unknown; approvalId?: string },
    ) {
      const { ctx } = call;
      const node = getNode(ctx.db, params.nodeId);
      if (!node) throw new PsycheError("not_found", `node ${params.nodeId} not found`);
      if (isUnreachableCapability(params.capability)) {
        throw new PsycheError(
          "forbidden",
          `${params.capability} is not reachable through nodes.invoke`,
        );
      }
      const capability = node.capabilities.find((c) => c.name === params.capability);
      if (!capability) {
        throw new PsycheError(
          "not_found",
          `node ${node.id} has no capability ${params.capability}`,
        );
      }
      const client = ctx.nodes.client(node.id);
      if (!client)
        throw new PsycheError("unavailable", `node ${node.id} is offline`, { retryable: true });

      const invocationId = ctx.db.newId();
      const intent: ToolCallIntent = {
        tool: `node.${capability.name}`,
        sideEffect: capability.sideEffect,
        ...(capability.targetKind ? { targetKind: capability.targetKind } : {}),
        params: params.params ?? null,
        paramsHash: `sha256:${paramsHash({ nodeId: node.id, capability: capability.name, params: params.params })}`,
      };
      const decision = await ctx.broker.decide(intent, {
        threadId: CLIENT_INVOKE_THREAD,
        runId: invocationId,
        permissionMode: "balanced",
        taint: false,
      });
      if (decision.decision === "deny") {
        throw new PsycheError("policy_denied", decision.reason ?? "denied by policy", {
          details: { rule: decision.rule },
        });
      }
      let approvalId: string | undefined;
      if (decision.decision === "ask") {
        const bindingHash = decision.bindingHash ?? intent.paramsHash;
        if (params.approvalId === undefined) {
          const issued = await ctx.broker.requestApproval({
            kind: decision.approvalKind ?? "computer_action",
            summary: `${capability.name} on ${node.kind}`,
            details: { nodeId: node.id, capability: capability.name },
            bindingHash,
            grantKey: decision.grantKey ?? `node.${capability.name}|${node.id}`,
            requestedBy: {
              runId: null,
              taskId: null,
              threadId: null,
              agent: `device:${call.identity.deviceId}`,
            },
            sideEffect: capability.sideEffect,
            surfaces: ["desktop"],
            ...(decision.scopesOffered ? { scopesOffered: decision.scopesOffered } : {}),
            taint: false,
          });
          ctx.bus.publish("approval.created", { approval: issued.approval });
          throw new PsycheError("approval_required", `${capability.name} needs an approval`, {
            details: { approvalId: issued.approval.id },
          });
        }
        const verified = await ctx.broker.verifyBinding(params.approvalId, bindingHash);
        if (!verified.ok) {
          throw new PsycheError(
            verified.reason === "binding_mismatch" ? "binding_mismatch" : "approval_required",
            `approval ${params.approvalId} does not cover this call (${verified.reason})`,
          );
        }
        approvalId = params.approvalId;
      }
      // On `allow` a client-supplied approvalId is not passed on: nothing verified it.

      const result = await client.invoke(
        capability.name,
        params.params,
        approvalId ? { approvalId } : {},
      );
      let receipt: Receipt | undefined;
      const sideEffecting = capability.sideEffect !== "none" && capability.sideEffect !== "read";
      if (result.receipt || sideEffecting) {
        receipt = await ctx.broker.recordReceipt({
          kind: `node.${capability.name}`,
          outcome: result.receipt?.outcome ?? (result.ok ? "ok" : "failed"),
          summary: result.receipt?.summary ?? `${capability.name} on ${node.kind}`,
          approvalId: approvalId ?? null,
          ...(result.receipt?.externalRefs ? { externalRefs: result.receipt.externalRefs } : {}),
        });
        ctx.bus.publish("receipt.created", { receipt });
      }
      const out: {
        invocationId: string;
        ok: boolean;
        result?: unknown;
        error?: ErrorPayload;
        receipt?: Receipt;
      } = { invocationId, ok: result.ok };
      if (result.result !== undefined) out.result = result.result;
      if (result.error !== undefined) out.error = result.error;
      if (receipt) out.receipt = receipt;
      return out;
    },
  },
  // Node → Gateway halves of the node protocol (scope `node`).
  "node.event": {
    run(call: Call, params: NodeEventParams) {
      call.ctx.nodes.onEvent(call.conn, params.invocationId, params.data);
      return { ok: true as const };
    },
  },
  "node.result": {
    run(call: Call, params: NodeResultParams) {
      call.ctx.nodes.onResult(call.conn, params.invocationId, params);
      return { ok: true as const };
    },
  },
  "node.invoke": {
    run() {
      throw new PsycheError("forbidden", "node.invoke flows Gateway → node only");
    },
  },
};
