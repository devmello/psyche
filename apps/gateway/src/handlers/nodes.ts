import { getNode } from "@psyche/db";
import {
  type ErrorPayload,
  isHostHelperKind,
  type JsonObject,
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
 * `dictation.*` types into whatever app has focus as the owner; only the desktop reaches it,
 * through the Gateway's own `dictation.*` methods (J9).
 * `screen.*` captures the owner's screen on the ask shortcut; only the desktop reaches it, through
 * the Gateway's own `screen.capture` (docs/design/screen-ask-2026.md).
 *
 * Capabilities that have a Gateway agent tool are reachable only through that tool, which
 * describes them (kind, binding, the full arguments on the card, #274): `apps.*` (AppleScript,
 * JXA, Shortcuts, open / focus), `computer.*` (sessions and per-app tiers), `messages.*`
 * (the iMessage channel's reply authority), `notify.*` (the Gateway's approval notifications),
 * `ocr.*` (search ingest's Vision OCR) and `llm.*` (the model router's Apple on-device model).
 * `presence.*` is the helper's Touch ID / Windows Hello key: only the Gateway picks what it signs
 * (a window's approval, `approvals.approveWithTouchId`) and reads the key it registers.
 * `teach.*` records the owner's own clicks, keys and screen to make a skill; `chrome.*` reads the
 * owner's open browser tabs: on any node, never through `nodes.invoke` (the Host helper's are
 * already behind the allowlist below; this keeps a remote node's out too).
 */
const UNREACHABLE =
  /^(vault|keychain|settings|permissions|grants|approvals|devices|gateway|dictation|apps|computer|messages|notify|screen|ocr|llm|presence|teach|chrome)([^a-z0-9]|$)/;

/**
 * The helper's own notification permission, which the desktop's onboarding and Settings read and
 * request (#384, #540). They carry no notification content; `notify.show` and the rest stay
 * unreachable.
 */
const CLIENT_REACHABLE: ReadonlySet<string> = new Set([
  "notify.authorization_status",
  "notify.request_authorization",
  // What the OS granted the helper, and its version and signing (`psyche doctor`): read-only,
  // never prompts.
  "permissions.status",
]);

/**
 * The Host's own helper (Mac or Windows) is reachable through `nodes.invoke` only for the capabilities in
 * `CLIENT_REACHABLE`. Everything else it offers (speech and the microphone, `vm.*`, the Apple
 * apps' data, Messages, reminders, calendar, contacts, ...) acts on the owner's Mac and has a
 * Gateway tool or method that describes it and asks; a deny list would miss whatever the helper
 * adds next, so this is an allowlist. Other nodes keep the deny list above.
 */
export function isHostHelperCapabilityReachable(name: string): boolean {
  return CLIENT_REACHABLE.has(name);
}

export function isUnreachableCapability(name: string): boolean {
  if (CLIENT_REACHABLE.has(name)) return false;
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
      if (
        (isHostHelperKind(node.kind) || ctx.nodes.isHostHelper(node.id)) &&
        !isHostHelperCapabilityReachable(params.capability)
      ) {
        throw new PsycheError(
          "forbidden",
          `${params.capability} is not reachable through nodes.invoke on the Host's ${node.kind === "win-helper" ? "Windows" : "Mac"} helper`,
        );
      }
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
            // The full arguments, as on every card (security §3.7); the broker sanitizes them.
            details: {
              nodeId: node.id,
              capability: capability.name,
              params: (params.params ?? null) as JsonObject[string],
            },
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
        if (!ctx.brokerPublishesReceipts) ctx.bus.publish("receipt.created", { receipt });
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
