import { createPublicKey, type KeyObject, verify } from "node:crypto";
import { getSetting, listDevices } from "@psyche/db";
import {
  approvalCode,
  cardHeader,
  type PresenceAssertion,
  type PresenceVerifier,
  presenceChallenge,
  renderForSurface,
  SURFACE_LIMITS,
} from "@psyche/permissions";
import {
  type ApprovalRequest,
  chatLinkRoute,
  type ErrorCode,
  type IssuedApproval,
  type NodeInfo,
  PsycheError,
  type Surface,
} from "@psyche/protocol";
import type { Call } from "../context.ts";
import type { Gateway } from "../server.ts";
import { surfaceOf } from "./handlers.ts";
import { DEV_FILE_KEY_SETTING, HelperPresenceKeys, presenceKeyHandlers } from "./presence-keys.ts";
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
 *
 * The desktop window has no key of its own, so Allow there (`approvals.approveWithTouchId`) asks
 * the helper to run Touch ID and sign the challenge for the window's own answer token
 * (`presence.confirm`). The Gateway picks the challenge and the card header the sheet names; the
 * broker checks the signature against the registered key exactly as for a notification answer.
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
   * approvals answered from that helper are refused. Default: the keys registered with
   * `devices.presenceKey.register` (issue #253); tests may pass their own.
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
export function helperPresenceVerifier(
  keys: HelperSetup["presenceKeys"],
  /** Whether `deviceId` is the Host's own connected Mac helper (`NodeRegistry.hostHelperOfDevice`). */
  isHostHelperDevice: (deviceId: string) => boolean,
): PresenceVerifier {
  return {
    async verify(assertion, challenge, deviceId) {
      if (assertion.kind !== "helper" || assertion.deviceId !== deviceId) return false;
      // A key registered for any other device (a second Mac, a guest) never counts, whatever its
      // signature: only the Host's helper speaks for the owner's presence on this Mac.
      if (!isHostHelperDevice(deviceId)) return false;
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
  /** The helper signs a window's approval after Touch ID (`presence.confirm`). */
  confirms: boolean;
}

/** Why the window's Touch ID approval cannot run; the card names the fix (`details.reason`). */
export type TouchIdUnavailable =
  | "helper_offline"
  | "helper_outdated"
  | "no_presence_key"
  | "presence_key_unavailable"
  | "presence_key_invalidated";

function touchIdUnavailable(reason: TouchIdUnavailable, message: string): PsycheError {
  return new PsycheError("unavailable", message, { details: { reason } });
}

/** A helper-supplied identifier (error code, reason), kept only when it looks like one. */
function helperWord(v: unknown): string | undefined {
  return typeof v === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(v) ? v : undefined;
}

/** The helper's own error code and reason, for logs (a plain object reads as `internal`). */
export function helperErrorFields(err: unknown): Record<string, string> {
  const e = (err ?? {}) as { code?: unknown; details?: { reason?: unknown } | null };
  const reason = helperWord(e.details?.reason);
  return { code: helperWord(e.code) ?? "unknown", ...(reason === undefined ? {} : { reason }) };
}

/** A helper-supplied message, as one short line. */
function helperMessage(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  const line = [...v]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? " " : ch;
    })
    .join("")
    .replace(/ +/g, " ")
    .trim();
  return line === "" ? fallback : line.slice(0, 200);
}

/** How long the owner has to touch the sensor. */
const CONFIRM_TIMEOUT_MS = 120_000;

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
  let stopped = false;
  const unsubscribe: (() => void)[] = [];

  const warn = (msg: string, err?: unknown) =>
    log?.log(
      "warn",
      msg,
      err === undefined
        ? {}
        : err instanceof Error
          ? { code: PsycheError.from(err).code }
          : helperErrorFields(err),
    );
  /** A window is confirming with Touch ID now: one sheet at a time, whatever the card. */
  let confirming = false;

  /** The live client of a Host helper only: this file never talks to any other node. */
  function client(nodeId: string) {
    const nodes = gateway?.context.nodes;
    return nodes?.isHostHelper(nodeId) === true ? nodes.client(nodeId) : undefined;
  }

  function detach(nodeId: string): void {
    const h = helpers.get(nodeId);
    if (h === undefined) return;
    h.abort.abort();
    helpers.delete(nodeId);
  }

  /**
   * The helper approval notifications go to: the Host's own, and only when it is the one Host
   * helper (`NodeRegistry.hostHelper` refuses to pick between two). Never "the newest helper":
   * a second Mac that paired as a node must not see the owner's approval cards.
   */
  function current(): Helper | undefined {
    const sole = gateway?.context.nodes.hostHelper();
    return sole === undefined ? undefined : helpers.get(sole.info.id);
  }

  function attach(node: NodeInfo): void {
    // A reconnect replaces the connection: drop the old subscription first. A node that is no
    // longer (or never was) the Host's helper must not keep one alive either.
    detach(node.id);
    if (stopped || node.kind !== "mac-helper" || node.status !== "online") return;
    // The kind says `mac-helper`; the registry says whether it is the Host's own.
    if (gateway?.context.nodes.isHostHelper(node.id) !== true) return;
    const names = new Set(node.capabilities.map((c) => c.name));
    if (!names.has("notify.show") || !names.has("notify.subscribe")) return;
    const h: Helper = {
      nodeId: node.id,
      deviceId: node.deviceId,
      abort: new AbortController(),
      confirms: names.has("presence.confirm"),
    };
    helpers.set(node.id, h);
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
    if (decision === undefined) {
      // A tap opens the app on the card's chat; dismiss decides nothing.
      if (data.actionId === "default") {
        const { threadId } = d.approval.requestedBy;
        gateway?.context.bus.publish("notification.opened", {
          notificationId: data.notificationId,
          route:
            threadId == null
              ? "/agent/approvals"
              : chatLinkRoute({ threadId, approvalId: d.approval.id }),
        });
      }
      return;
    }
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
    const h = current();
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
        route:
          a.requestedBy.threadId == null
            ? "/agent/approvals"
            : chatLinkRoute({ threadId: a.requestedBy.threadId, approvalId: a.id }),
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

  const keyStore = new HelperPresenceKeys(services.db);
  const presenceKeys = setup.presenceKeys ?? ((deviceId: string) => keyStore.get(deviceId));
  const verifier = helperPresenceVerifier(
    presenceKeys,
    (deviceId) => gateway?.context.nodes.hostHelperOfDevice(deviceId) !== undefined,
  );
  const handlers = presenceKeyHandlers({
    store: keyStore,
    audit: services.audit,
    // A Touch ID key is registered only for the Host's own helper (never a node of another Mac
    // that happens to share the device id the caller names).
    helperNode: (deviceId) => gateway?.context.nodes.hostHelperOfDevice(deviceId)?.info.id,
    invoke: async (nodeId, capability) => {
      const c = client(nodeId);
      if (c === undefined) return { ok: false, error: { code: "unavailable", message: "gone" } };
      return c.invoke(capability, {}, { timeoutMs: 10_000 });
    },
    now: () => new Date(services.clock.now()),
    allowDevFileKey: () => getSetting(services.db, DEV_FILE_KEY_SETTING)?.value === true,
  });

  /**
   * The connected helper that signs for the window, or why none can. With `deviceId` (the helper
   * the desktop launched from its own bundle, read with `psyche-helper --print-identity`), only
   * that one: another node that paired as a helper never gets the challenge. Without it, only
   * when exactly one Host helper is connected; two is ambiguous and nothing is asked (the same
   * rule as every other Host-bound capability, `NodeRegistry.hostHelper`).
   */
  function touchIdHelper(deviceId: string | undefined): Helper {
    const connected = [...helpers.values()]
      .reverse()
      .filter((h) => deviceId === undefined || h.deviceId === deviceId);
    if (connected.length === 0) {
      throw touchIdUnavailable(
        "helper_offline",
        "Psyche Helper is not running, so Touch ID cannot confirm this approval",
      );
    }
    if (deviceId === undefined && connected.length > 1) {
      throw touchIdUnavailable(
        "helper_offline",
        "More than one Psyche Helper is connected, so Touch ID cannot tell which Mac should confirm this approval",
      );
    }
    const able = connected.filter((h) => h.confirms);
    if (able.length === 0) {
      throw touchIdUnavailable(
        "helper_outdated",
        "This Psyche Helper cannot confirm approvals from the window; update Psyche",
      );
    }
    const keyed = able.find((h) => presenceKeys(h.deviceId) !== undefined);
    if (keyed === undefined) {
      throw touchIdUnavailable(
        "no_presence_key",
        "Touch ID is not set up for approvals: register the helper's Touch ID key first",
      );
    }
    return keyed;
  }

  async function approveWithTouchId(
    call: Call,
    params: {
      approvalId: string;
      answerToken: string;
      scope?: "once";
      helperDeviceId?: string;
    },
  ) {
    // Only the Psyche app on this Mac, whose Allow the owner just clicked, may raise the prompt.
    if (call.identity.desktopShell !== true) {
      throw new PsycheError(
        "forbidden",
        "Touch ID approvals come from the Psyche app on this Mac",
        {
          details: { reason: "not_desktop" },
        },
      );
    }
    const a = await services.rawBroker.get(params.approvalId);
    if (a === undefined)
      throw new PsycheError("not_found", `approval ${params.approvalId} not found`);
    if (a.status !== "pending")
      throw new PsycheError("answer_late", `approval already ${a.status}`);
    if ((params as { unsandboxed?: unknown }).unsandboxed !== undefined) {
      // Not in the signed challenge: a window must not be able to add it on its own.
      throw new PsycheError(
        "invalid_params",
        "Running a command without the sandbox can't be approved from the window with Touch ID",
      );
    }
    if (!a.requiresAuthentication) {
      throw new PsycheError(
        "invalid_params",
        "This approval needs no Touch ID; answer it directly",
      );
    }
    if (confirming) {
      throw new PsycheError("conflict", "Touch ID is already asking about an approval");
    }
    // Taken before the first await, so two calls racing through the checks raise one sheet.
    confirming = true;
    try {
      const h = touchIdHelper(params.helperDeviceId);
      const c = client(h.nodeId);
      if (c === undefined) throw touchIdUnavailable("helper_offline", "Psyche Helper went away");
      const by = { deviceId: h.deviceId, surface: surfaceOf(services.db, call.identity.deviceId) };
      // Before any sheet: the token is this window's unused one, the card is armed, and this
      // answerer is not over its rate limit (a bad token counts against the rejected-answer cap).
      await services.rawBroker.precheckAnswer({
        approvalId: a.id,
        answerToken: params.answerToken,
        decidedBy: by,
      });
      const res = await c.invoke(
        "presence.confirm",
        {
          challenge: presenceChallenge(a.id, a.bindingHash, params.answerToken),
          // The sheet names this approval: its summary and the code the card shows.
          summary: a.summary,
          code: approvalCode(a.bindingHash),
        },
        { timeoutMs: CONFIRM_TIMEOUT_MS },
      );
      const out = (res.result ?? {}) as { signature?: unknown; keyId?: unknown };
      if (!res.ok || typeof out.signature !== "string") {
        const f = helperErrorFields(res.error);
        // Every failed confirm counts like a rejected answer, so a window cannot raise sheets
        // without limit.
        const reject = (reason: string, code: ErrorCode, message: string, details?: object) =>
          services.rawBroker.rejectPresence({
            approvalId: a.id,
            decidedBy: by,
            reason,
            code,
            message,
            ...(details === undefined ? {} : { details }),
          });
        if (f.reason === "missing_entitlement") {
          return reject(
            "presence_key_unavailable",
            "unavailable",
            "This build of Psyche Helper cannot keep a Touch ID key (it has no keychain access group)",
            { reason: "presence_key_unavailable" },
          );
        }
        if (f.reason === "presence_key_invalidated") {
          return reject(
            "presence_key_invalidated",
            "unavailable",
            "Touch ID changed since this key was set up; set up Touch ID again in Settings → Devices",
            { reason: "presence_key_invalidated" },
          );
        }
        if (f.code === "cancelled")
          return reject("presence_cancelled", "cancelled", "Touch ID was cancelled");
        return reject(
          "presence_failed",
          "forbidden",
          helperMessage(res.error?.message, "Touch ID did not confirm it"),
          { reason: "touch_id_failed", ...(f.reason ? { helperReason: f.reason } : {}) },
        );
      }
      void services.audit
        .append({
          kind: "approval.touch_id_from_window",
          actor: { type: "device", deviceId: call.identity.deviceId },
          data: {
            approvalId: a.id,
            helperDeviceId: h.deviceId,
            ...(typeof out.keyId === "string" ? { keyId: out.keyId } : {}),
          },
        })
        .catch(() => undefined);
      // The answer is the window's (its token, its surface); the presence is the helper's key,
      // so the helper device decides it, as for a notification answer. `once` only: the scope is
      // not part of the signed challenge, so the window cannot widen it.
      const approval = await services.rawBroker.answer({
        approvalId: a.id,
        answerToken: params.answerToken,
        decision: "approve",
        scope: "once",
        decidedBy: by,
        presence: {
          kind: "helper",
          deviceId: h.deviceId,
          signature: out.signature,
          ...(typeof out.keyId === "string" ? { payload: { keyId: out.keyId } } : {}),
        },
      });
      const grant =
        approval.grantId == null
          ? null
          : ((await services.rawBroker.listGrants({ includeRevoked: true })).find(
              (g) => g.id === approval.grantId,
            ) ?? null);
      return { approval, grant };
    } finally {
      confirming = false;
    }
  }

  return {
    handlers: {
      ...handlers,
      "approvals.approveWithTouchId": { run: approveWithTouchId },
    },
    relay: {
      surfaces: () => (current() === undefined ? [] : [HELPER_SURFACE]),
      deliver,
      isOwnerSender: async () => false,
    },
    approver: (deviceId) => [...helpers.values()].some((h) => h.deviceId === deviceId),
    presence: {
      kind: "helper",
      verifier,
      // Ready only while some paired, non-revoked device has a registered key: without one no
      // assertion can pass, and gating security settings on it would lock the owner out.
      ready: () =>
        listDevices(services.db).some(
          (d) => d.pairedAt !== null && !d.revokedAt && presenceKeys(d.id) !== undefined,
        ),
    },
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
