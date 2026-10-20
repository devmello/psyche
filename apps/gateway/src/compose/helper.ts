import { createPublicKey, type KeyObject, verify } from "node:crypto";
import {
  cardHeader,
  type PresenceAssertion,
  type PresenceVerifier,
  presenceChallenge,
  renderForSurface,
  SURFACE_LIMITS,
} from "@psyche/permissions";
import {
  type ApprovalRequest,
  type IssuedApproval,
  type NodeInfo,
  PsycheError,
  type Surface,
} from "@psyche/protocol";
import type { Gateway } from "../server.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * Approvals on the Mac through the helper (S14, security §3.7 "macOS notification with Approve /
 * Deny"). While a mac-helper node is connected, every approval also gets the `notification`
 * surface; the card goes to the helper as `notify.show`, and the helper's `notify.response`
 * (over the long-lived `notify.subscribe`) becomes a broker answer with that surface's token.
 * The token never leaves the Gateway.
 *
 * Approvals that require authentication (purchase, credential fill, host exec, pairing, policy)
 * need a presence assertion: a Secure Enclave signature, made after Touch ID, over
 * `presenceChallenge(approvalId, bindingHash, answerToken)`, checked against a key the owner
 * registered for that helper. The helper's `authenticated: true` alone proves nothing (any
 * process holding the handshake secret can pair as a helper and send it), so without a signed
 * assertion and a registered key those approvals stay refused. Deny always works.
 */

export const HELPER_SURFACE: Surface = "notification";

/** Domain-separated bytes the helper's presence key signs. */
export function helperPresenceMessage(challenge: string): Buffer {
  return Buffer.from(`psyche.presence.helper.v1|${challenge}`, "utf8");
}

export interface HelperSetup {
  /**
   * The owner-registered presence key of a helper device: a Secure Enclave P-256 public key in
   * X9.63 uncompressed form (`SecKeyCopyExternalRepresentation`), base64url. No key → presence
   * approvals answered from that helper are refused.
   */
  presenceKeys?: (deviceId: string) => string | undefined;
}

function p256Key(b64url: string): KeyObject {
  const raw = Buffer.from(b64url, "base64url");
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error("not an uncompressed P-256 point");
  return createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
}

/** Verifies `kind: "helper"` assertions: ECDSA P-256 / SHA-256 (DER) by the device's registered key. */
export function helperPresenceVerifier(keys: HelperSetup["presenceKeys"]): PresenceVerifier {
  return {
    async verify(assertion, challenge, deviceId) {
      if (assertion.kind !== "helper" || assertion.deviceId !== deviceId) return false;
      const registered = keys?.(deviceId);
      if (registered === undefined) return false;
      try {
        return verify(
          "sha256",
          helperPresenceMessage(challenge),
          { key: p256Key(registered), dsaEncoding: "der" },
          Buffer.from(assertion.signature, "base64url"),
        );
      } catch {
        return false;
      }
    },
  };
}

/** The helper's `notify.response` event (apps/mac-helper README, Notifications). */
interface NotifyResponse {
  type: "notify.response";
  notificationId: string;
  actionId: string;
  authenticated?: boolean;
  /** Proposed (S14 issue): the Secure Enclave signature over `helperPresenceMessage`. */
  presence?: { signature?: unknown; keyId?: unknown };
}

function isResponse(data: unknown): data is NotifyResponse {
  const d = data as Partial<NotifyResponse> | null;
  return (
    typeof d === "object" &&
    d !== null &&
    d.type === "notify.response" &&
    typeof d.notificationId === "string" &&
    typeof d.actionId === "string"
  );
}

interface Helper {
  nodeId: string;
  deviceId: string;
  abort: AbortController;
}

interface Delivery {
  approval: ApprovalRequest;
  token: string;
  nodeId: string;
}

/** Longest timer Node accepts; the subscription is re-opened when it runs out. */
const SUBSCRIBE_TIMEOUT_MS = 2_147_483_647;

/**
 * The notification card: the fixed template (design-12) when it fits a notification, with
 * Approve / Deny; otherwise the header and Deny only, so nothing is approved from a cut card.
 */
function card(a: ApprovalRequest): { title: string; body: string; approvable: boolean } {
  const title = cardHeader(a);
  const full = renderForSurface("desktop", a);
  if (full.text.length <= SURFACE_LIMITS.notification) {
    return { title, body: full.text.split("\n").slice(1).join("\n"), approvable: true };
  }
  return { title, body: "Open Psyche on your Mac to review.", approvable: false };
}

export function composeHelper(services: ComposeServices, setup: HelperSetup = {}): ComposedPart {
  const log = services.logger;
  const helpers = new Map<string, Helper>();
  const deliveries = new Map<string, Delivery>();
  let gateway: Gateway | undefined;
  let latest: Helper | undefined;
  let stopped = false;
  const unsubscribe: (() => void)[] = [];

  const warn = (msg: string, err?: unknown) =>
    log?.log("warn", msg, err === undefined ? {} : { code: PsycheError.from(err).code });

  function client(nodeId: string) {
    return gateway?.context.nodes.client(nodeId);
  }

  function detach(nodeId: string): void {
    const h = helpers.get(nodeId);
    if (h === undefined) return;
    h.abort.abort();
    helpers.delete(nodeId);
    if (latest === h) latest = [...helpers.values()].at(-1);
  }

  function attach(node: NodeInfo): void {
    if (stopped || node.kind !== "mac-helper" || node.status !== "online") return;
    const names = new Set(node.capabilities.map((c) => c.name));
    if (!names.has("notify.show") || !names.has("notify.subscribe")) return;
    // A reconnect replaces the connection: drop the old subscription, open a new one.
    detach(node.id);
    const h: Helper = { nodeId: node.id, deviceId: node.deviceId, abort: new AbortController() };
    helpers.set(node.id, h);
    latest = h;
    void subscribe(h);
  }

  async function subscribe(h: Helper): Promise<void> {
    while (!stopped && helpers.get(h.nodeId) === h) {
      const c = client(h.nodeId);
      if (c === undefined) break;
      const res = await c.invoke(
        "notify.subscribe",
        {},
        {
          timeoutMs: SUBSCRIBE_TIMEOUT_MS,
          signal: h.abort.signal,
          onEvent: (e) => void onResponse(h, e.data),
        },
      );
      if (!res.ok && res.error?.code !== "timeout") break;
    }
    if (helpers.get(h.nodeId) === h) detach(h.nodeId);
  }

  async function onResponse(h: Helper, data: unknown): Promise<void> {
    if (!isResponse(data)) return;
    const d = deliveries.get(data.notificationId);
    // Only the helper the card went to answers it.
    if (d === undefined || d.nodeId !== h.nodeId || helpers.get(h.nodeId) !== h) return;
    const decision =
      data.actionId === "approve" ? "approve" : data.actionId === "deny" ? "deny" : undefined;
    if (decision === undefined) return; // a tap opens the app; dismiss decides nothing
    const signature = data.presence?.signature;
    const presence: PresenceAssertion | undefined =
      decision === "approve" &&
      d.approval.requiresAuthentication &&
      data.authenticated === true &&
      typeof signature === "string"
        ? {
            kind: "helper",
            deviceId: h.deviceId,
            signature,
            ...(typeof data.presence?.keyId === "string"
              ? { payload: { keyId: data.presence.keyId } }
              : {}),
          }
        : undefined;
    try {
      await services.rawBroker.answer({
        approvalId: d.approval.id,
        answerToken: d.token,
        decision,
        ...(decision === "approve" ? { scope: "once" as const } : {}),
        decidedBy: { deviceId: h.deviceId, surface: HELPER_SURFACE },
        ...(presence === undefined ? {} : { presence }),
      });
    } catch (err) {
      // Refused answers are audited by the broker; the approval stays pending on the other surfaces.
      warn("approval answer from the Mac notification refused", err);
    }
  }

  async function deliver(issued: IssuedApproval): Promise<void> {
    const a = issued.approval;
    const token = issued.answerTokens[HELPER_SURFACE];
    const h = latest;
    if (token === undefined || h === undefined || a.status !== "pending") return;
    const c = client(h.nodeId);
    if (c === undefined) return;
    const { title, body, approvable } = card(a);
    deliveries.set(a.id, { approval: a, token, nodeId: h.nodeId });
    const deny = {
      id: "deny",
      label: "Deny",
      destructive: true,
      authenticationRequired: false,
      textInput: false,
    };
    const res = await c.invoke(
      "notify.show",
      {
        id: a.id,
        category: "approval",
        title,
        body,
        interruptionLevel: "timeSensitive",
        threadId: a.requestedBy.taskId ?? null,
        route: `/approvals/${a.id}`,
        actions: approvable
          ? [
              {
                id: "approve",
                label: "Approve",
                destructive: false,
                authenticationRequired: a.requiresAuthentication,
                textInput: false,
              },
              deny,
            ]
          : [deny],
        approvalId: a.id,
        requireBiometry: a.requiresAuthentication,
        // What the helper's presence key signs after Touch ID (proposed, S14 issue).
        ...(a.requiresAuthentication
          ? { presenceChallenge: presenceChallenge(a.id, a.bindingHash, token) }
          : {}),
      },
      { timeoutMs: 10_000 },
    );
    if (!res.ok) {
      deliveries.delete(a.id);
      warn("approval notification to the Mac helper failed", res.error);
    }
  }

  function settle(approvalId: string): void {
    const d = deliveries.get(approvalId);
    if (d === undefined) return;
    deliveries.delete(approvalId);
    void client(d.nodeId)
      ?.invoke("notify.withdraw", { id: approvalId }, { timeoutMs: 10_000 })
      .catch(() => undefined);
  }

  const verifier = helperPresenceVerifier(setup.presenceKeys);

  return {
    relay: {
      surfaces: () => (latest === undefined ? [] : [HELPER_SURFACE]),
      deliver,
      isOwnerSender: async () => false,
    },
    approver: (deviceId) => [...helpers.values()].some((h) => h.deviceId === deviceId),
    presence: { kind: "helper", verifier },
    start(gw) {
      gateway = gw;
      unsubscribe.push(
        services.rawBroker.subscribe((e) => {
          if (
            e.type === "approval.decided" ||
            e.type === "approval.expired" ||
            e.type === "approval.invalidated"
          ) {
            settle(e.approval.id);
          }
        }),
        gw.bus.subscribe(["operator.read"], (frame) => {
          const f = JSON.parse(frame) as { event?: string; payload?: { node?: NodeInfo } };
          const node = f.payload?.node;
          if (f.event !== "node.updated" || node === undefined) return;
          if (node.status === "online" && gw.context.nodes.isLive(node.id)) attach(node);
          else detach(node.id);
        }),
      );
      for (const node of gw.context.nodes.list()) {
        if (gw.context.nodes.isLive(node.id)) attach(node);
      }
    },
    stop() {
      stopped = true;
      for (const u of unsubscribe.splice(0)) u();
      for (const id of [...helpers.keys()]) detach(id);
      deliveries.clear();
    },
  };
}
