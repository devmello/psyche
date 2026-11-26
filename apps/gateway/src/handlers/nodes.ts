import { getDevice, getDeviceFamily, getNode } from "@psyche/db";
import {
  type ErrorPayload,
  isHostHelperKind,
  type JsonObject,
  type NodeEventParams,
  type NodeResultParams,
  PHONE_CAPABILITY_NAMES,
  PsycheError,
  type Receipt,
  type ToolCallIntent,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import { paramsHash } from "../idempotency.ts";
import { isMachineInvokeReachable } from "../nodes/machines.ts";

/**
 * Capability namespaces a client can never reach through `nodes.invoke`: the helper's vault and
 * keychain, and anything that changes security settings (architecture §6, §11; security §4.3,
 * §10; S23 review TODO). The agent's own node tools go through the same broker path (S02).
 * `dictation.*` types into whatever app has focus as the owner; only the desktop reaches it,
 * through the Gateway's own `dictation.*` methods (J9).
 * `screen.*` captures the owner's screen on the ask shortcut; only the desktop reaches it, through
 * the Gateway's own `screen.capture` (docs/design/screen-ask-2026.md).
 * `vscreen.*` is the Linux helper's virtual screen: its frames show the agent's apps and its input
 * types into them. Only the desktop's watch pane reaches it, through the Gateway's own
 * `computerWatch.*` methods, on any node.
 *
 * Capabilities that have a Gateway agent tool are reachable only through that tool, which
 * describes them (kind, binding, the full arguments on the card, #274): `apps.*` (AppleScript,
 * JXA, Shortcuts, open / focus), `computer.*` (sessions and per-app tiers), `messages.*`
 * (`messages_send` and the Messages readers), `notify.*` (the Gateway's approval notifications),
 * `ocr.*` (search ingest's Vision OCR) and `llm.*` (the model router's Apple on-device model).
 * `teach.*` records the owner's actions in a desktop app (teach by showing, phase 2): only the
 * desktop shell reaches it, through the Gateway's own `teach.app.*` methods, so neither a client
 * nor an agent tool can start, stop or read a recording, on any node.
 * `presence.*` is the helper's Touch ID / Windows Hello key: only the Gateway picks what it signs
 * (a window's approval, `approvals.approveWithTouchId`) and reads the key it registers.
 * `location.*` is the owner's phone position: only the agent's `location_current` tool reads it
 * (it records the use), never a client through `nodes.invoke`.
 * `chrome.*` reads the owner's open browser tabs: never through `nodes.invoke` on any node (the
 * Host helper's are already behind the allowlist below; this keeps a remote node's out too).
 */
const UNREACHABLE =
  /^(vault|keychain|settings|permissions|grants|approvals|devices|gateway|dictation|apps|computer|messages|notify|screen|ocr|llm|presence|teach|chrome|vscreen|location|points)([^a-z0-9]|$)/;

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
 * Read-only listings Settings shows from the Host helper: the names of the owner's Reminders lists
 * (Outlook task lists on Windows), calendars and Notes folders for "These are mine — treat as
 * trusted" (TrustedSourcesCard), and their Shortcuts (ConnectorSettingsCards). Names and ids
 * only, no items, events, notes or runs; every other capability in those groups stays out.
 */
const SETTINGS_LISTINGS: ReadonlySet<string> = new Set([
  "reminders.list_lists",
  "calendar.list_calendars",
  "notes.folders",
  "shortcuts.list",
]);

/**
 * The Host's own helper (Mac or Windows) is reachable through `nodes.invoke` only for the
 * capabilities in `CLIENT_REACHABLE` and `SETTINGS_LISTINGS`. Everything else it offers (speech
 * and the microphone, `vm.*`, the Apple apps' data, Messages, reminders, calendar, contacts, ...)
 * acts on the owner's computer and has a Gateway tool or method that describes it and asks; a
 * deny list would miss whatever the helper adds next, so this is an allowlist. Other nodes keep
 * the deny list above.
 */
export function isHostHelperCapabilityReachable(name: string): boolean {
  return CLIENT_REACHABLE.has(name) || SETTINGS_LISTINGS.has(name);
}

export function isUnreachableCapability(name: string): boolean {
  if (CLIENT_REACHABLE.has(name)) return false;
  return UNREACHABLE.test(name.toLowerCase());
}

/**
 * Settings asks the Host's Mac helper for its own Accessibility, Screen Recording and
 * Notifications grants (macOS grants are per app identity: "Psyche Helper", not Psyche.app). Only
 * the owner's click in the desktop app, and only on the Host's helper: the helper shows the system
 * prompt or opens the pane, nothing else. Screen Recording keeps the helper's own
 * `vision_fallback` purpose. Any other permission, extra argument, caller or node stays refused.
 */
const HELPER_PERMISSIONS: ReadonlySet<unknown> = new Set(["accessibility", "screenRecording"]);

/** Exactly these keys, own properties only (`Object.hasOwn`, so a prototype never answers). */
function hasOnly(p: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(p);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(p, k));
}

/**
 * The helper's own permission prompts, asked for by the owner's click (Settings → Computer use
 * and → Notifications). Accessibility and Screen Recording go through `permissions.request`;
 * Notifications through `notify.request_authorization` (the explicit prompt, never provisional);
 * `permissions.open_settings` opens the pane of any of the three. Everything else stays refused.
 */
export function isHelperPermissionPrompt(capability: string, params: unknown): boolean {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return false;
  const p = params as Record<string, unknown>;
  if (capability === "notify.request_authorization") {
    return hasOnly(p, ["provisional"]) && p.provisional === false;
  }
  if (capability === "permissions.open_settings") {
    return (
      hasOnly(p, ["permission"]) &&
      (HELPER_PERMISSIONS.has(p.permission) || p.permission === "notifications")
    );
  }
  if (capability !== "permissions.request" || !Object.hasOwn(p, "permission")) return false;
  if (p.permission === "accessibility") return hasOnly(p, ["permission"]);
  if (p.permission === "screenRecording") {
    return hasOnly(p, ["permission", "purpose"]) && p.purpose === "vision_fallback";
  }
  return false;
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
      const hostHelper = isHostHelperKind(node.kind) || ctx.nodes.isHostHelper(node.id);
      // Only the owner's own desktop app (a loopback desktop-shell connection) may prompt: a
      // paired phone, another Mac or a leaked write token must not spam the Host with TCC sheets.
      const permissionPrompt =
        hostHelper &&
        call.identity.desktopShell === true &&
        call.conn.peer.remoteLoopback &&
        isHelperPermissionPrompt(params.capability, params.params);
      if (hostHelper && !permissionPrompt && !isHostHelperCapabilityReachable(params.capability)) {
        throw new PsycheError(
          "forbidden",
          `${params.capability} is not reachable through nodes.invoke on the Host's ${node.kind === "win-helper" ? "Windows" : node.kind === "host-helper" ? "Linux" : "Mac"} helper`,
        );
      }
      // A machine (a paired Linux computer) is reached through the agent's tools only. The one
      // client path is its health and its own status report: `computer.*`, `apps.*`, `vscreen.*`,
      // `exec.*`, `fs.*` and anything it adds later are refused here, by an allowlist, however the
      // name is spelled. The kind is the stored decision (or a live machine of this device), never
      // what the node declared.
      if (
        (node.kind === "machine" || ctx.nodes.machine(node.deviceId) !== undefined) &&
        !isMachineInvokeReachable(params.capability)
      ) {
        throw new PsycheError(
          "forbidden",
          `${params.capability} is not reachable through nodes.invoke on a machine`,
        );
      }
      if (!permissionPrompt && isUnreachableCapability(params.capability)) {
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
      // The owner's own click on Allow is the consent; the prompt itself is the OS's.
      const decision = permissionPrompt
        ? ({ decision: "allow" } as Awaited<ReturnType<typeof ctx.broker.decide>>)
        : await ctx.broker.decide(intent, {
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
  // The owner's phone offering `location.current` (and nothing else) on its operator connection.
  "phone.capabilities.set": {
    run(call: Call, params: { capabilities: string[] }) {
      const { ctx, identity } = call;
      const device = getDevice(ctx.db, identity.deviceId);
      // Only the owner's own paired iPhone/iPad: an iOS device row whose family was pinned when it
      // paired (a device cannot change it later), on a client connection that is not the desktop,
      // a Host helper, a machine or a guest.
      if (
        identity.role !== "client" ||
        identity.hostHelper === true ||
        identity.machine === true ||
        identity.guestContainer !== undefined ||
        identity.desktopShell === true ||
        device === undefined ||
        device.revokedAt ||
        device.platform !== "ios" ||
        getDeviceFamily(ctx.db, identity.deviceId) !== "ios"
      ) {
        throw new PsycheError(
          "forbidden",
          "Only the owner's paired iPhone can offer phone capabilities",
        );
      }
      const wanted = params.capabilities.filter((c) =>
        (PHONE_CAPABILITY_NAMES as readonly string[]).includes(c),
      );
      const node = ctx.nodes.setPhoneCapabilities(call.conn, identity, wanted);
      return {
        capabilities: (node?.status === "online" ? node.capabilities : []).map((c) => c.name),
      };
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
