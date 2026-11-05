import { type Static, Type } from "@sinclair/typebox";
import { DeviceScope, Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { Device, PairingRequest, PairingStatus } from "../schemas/identity.ts";
import { defineMethod } from "./define.ts";

/** `devices.*`: pairing and device management; every method needs `operator.admin` (security §10). */

/** Hex SHA-256 of the helper's X9.63 public key, as the helper reports it. */
const KeyId = Type.String({ pattern: "^[0-9a-f]{64}$" });

export const PresenceKeyInfo = Type.Object(
  {
    deviceId: Id,
    keyId: KeyId,
    registeredAt: IsoDateTime,
    /**
     * Where the helper keeps it: `keychain` (data-protection keychain, bound to the helper's
     * access group), or `enclave_file` (a Secure Enclave key whose wrapped blob is a file, on
     * builds without a provisioning profile; any same-user process could ask it to sign behind
     * its own Touch ID prompt, security §10). Absent for keys registered before it was reported.
     */
    kind: Type.Optional(StringEnum(["keychain", "enclave_file"])),
  },
  { $id: "PresenceKeyInfo" },
);

/**
 * What a setup token can grant. Never `node`: a token pairs a computer's app, and a node's
 * authority is a separate decision (remote-gateway design §3.5).
 */
export const SetupTokenScope = StringEnum(
  ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
  { $id: "SetupTokenScope" },
);
export type SetupTokenScope = Static<typeof SetupTokenScope>;

/**
 * Where the computer that uses a setup token will connect. `address` (the default) uses
 * `gateway.publicOrigin` and makes a `psyche-pair:v1` link (a CA-certified address, for example
 * Tailscale). `lan` uses this Gateway's LAN address and certificate and makes a `psyche-pair:v2`
 * link; `unavailable` while LAN listening is not running.
 */
export const SetupTokenVia = StringEnum(["address", "lan"], { $id: "SetupTokenVia" });
export type SetupTokenVia = Static<typeof SetupTokenVia>;

/** A one-time setup token as the Host lists it. The token itself is shown once, inside the link. */
export const SetupTokenInfo = Type.Object(
  {
    id: Id,
    scopes: Type.Array(SetupTokenScope),
    createdAt: IsoDateTime,
    expiresAt: IsoDateTime,
    usedAt: Nullable(IsoDateTime),
    usedByDeviceId: Nullable(Id),
    revokedAt: Nullable(IsoDateTime),
    status: StringEnum(["live", "used", "expired", "revoked"]),
  },
  { $id: "SetupTokenInfo" },
);

export const DevicesMethods = {
  "devices.list": defineMethod({
    params: Type.Object({ includeRevoked: Type.Optional(Type.Boolean()) }),
    result: Type.Object({ devices: Type.Array(Device) }),
    scope: "operator.admin",
    description: "Lists paired devices.",
  }),
  "devices.approve": defineMethod({
    params: Type.Object({
      pairingRequestId: Id,
      scopes: Type.Array(DeviceScope, {
        minItems: 1,
        description: "Owner-chosen scopes; never taken from the client",
      }),
      code: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 32,
          description: "The code shown on the new device; when given it must match the request",
        }),
      ),
      /** Fresh presence: the approved `policy_change` card from a first `approval_required` call. */
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({ device: Device }),
    scope: "operator.admin",
    description:
      "Approves a pending pairing request with owner-chosen scopes. Needs fresh presence once the Gateway has a presence verifier (approval_required with details.approvalId, then retry with approvalId; presence_required when presence was enrolled but nothing can verify now).",
  }),
  "devices.deny": defineMethod({
    params: Type.Object({
      pairingRequestId: Id,
      reason: Type.Optional(Type.String({ maxLength: 500 })),
    }),
    result: Type.Object({ pairingRequest: PairingRequest }),
    scope: "operator.admin",
    description: "Denies a pending pairing request.",
  }),
  "devices.bootstrapAdmin": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ device: Device }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "First run without a terminal: grants operator.admin to the calling device when the Gateway has no operator.admin device at all, in one transaction, and audits it as device.bootstrap_admin. Only the desktop shell's own connection may call it (loopback, no Origin, deviceFamily desktop, the per-launch handshake secret); forbidden otherwise, conflict once any admin exists. Side-effecting.",
  }),
  "devices.revoke": defineMethod({
    params: Type.Object({ deviceId: Id }),
    result: Type.Object({ device: Device }),
    scope: "operator.admin",
    description:
      "Revokes a device's token and node authority permanently and closes its connections.",
  }),
  "devices.revokeSelf": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ device: Device }),
    scope: "operator.read",
    description:
      "Revokes the calling device itself: the same effect as devices.revoke on its own id (token and node authority end permanently), and this connection closes right after the reply. Needs no admin scope, because a device may always remove itself, and takes no device id, so it can never name another device. Audited as device.revoked_self. Not idempotency-keyed: a repeat finds the device already revoked and cannot connect to repeat it.",
  }),
  "devices.pairing.list": defineMethod({
    params: Type.Object({ status: Type.Optional(PairingStatus) }),
    result: Type.Object({ pairingRequests: Type.Array(PairingRequest) }),
    scope: "operator.admin",
    description: "Lists pairing requests (default: pending).",
  }),
  "devices.presenceKey.list": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ presenceKeys: Type.Array(PresenceKeyInfo) }),
    scope: "operator.admin",
    description:
      "Lists the registered helper presence keys (Touch ID approvals, issue #253): device id and key id only.",
  }),
  "devices.presenceKey.register": defineMethod({
    params: Type.Object({
      /** A paired, connected helper (`role: node`) exposing `presence.public_key`. */
      deviceId: Id,
      /**
       * The key id the genuine helper shows (`psyche-helper --print-identity`, which the desktop
       * runs from its own bundle): the connected helper's key must match, so a process that
       * paired as a helper cannot register its own key (security §10).
       */
      expectKeyId: KeyId,
      /** Fresh presence: the approved `policy_change` card from a first `approval_required` call. */
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({ presenceKey: PresenceKeyInfo }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Reads the helper's Secure Enclave presence key (`presence.public_key`) and registers it for that device when its key id equals expectKeyId, so its Touch ID answers verify. A Secure Enclave file key (kind enclave_file, development builds) is refused unless the setting devices.presence.allowDevFileKey is true. Replaces an earlier key; revoked with the device. Needs fresh presence once the Gateway has a presence verifier (approval_required, then retry with approvalId; presence_required when presence was enrolled but nothing can verify now). Side-effecting.",
  }),
  "devices.presenceKey.remove": defineMethod({
    params: Type.Object({ deviceId: Id }),
    result: Type.Object({ removed: Type.Boolean() }),
    scope: "operator.admin",
    sideEffecting: true,
    description: "Removes a helper's registered presence key. Side-effecting.",
  }),
  "devices.setupToken.create": defineMethod({
    params: Type.Object({
      scopes: Type.Array(SetupTokenScope, {
        minItems: 1,
        description:
          "What the computer that uses the token gets, chosen by the owner now; never `node`. `operator.admin` only when the owner ticks it",
      }),
      via: Type.Optional(SetupTokenVia),
      /** Fresh presence: the approved `policy_change` card from a first `approval_required` call. */
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({
      setupToken: SetupTokenInfo,
      link: Type.String({
        description:
          "psyche-pair:v1 link (gatewayUrl, gatewayFingerprint, setupToken, hostName) for an address, or psyche-pair:v2 link (gatewayUrl, gatewayKey, certPin, setupToken, hostName) for the LAN; nothing else. The token appears only here, once",
      }),
      version: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 2,
          description: "1 or 2: which link format `link` is",
        }),
      ),
      gatewayUrl: Type.String(),
      gatewayFingerprint: Type.String(),
      hostName: Type.String(),
    }),
    scope: "operator.admin",
    description:
      "Makes a single-use setup token (10 minutes, 256 random bits, stored only as a hash) and the pairing link that carries it. A computer that connects with the token, after verifying the Gateway's fingerprint, is paired at once with exactly these scopes; one without it still waits for approval. At most three live tokens; `unavailable` when gateway.publicOrigin is not set. Needs fresh presence once the Gateway has a presence verifier (approval_required with details.approvalId, then retry with approvalId). Not idempotent on purpose: every call makes a new token, and the link is never kept anywhere in the clear, not even as a stored idempotent result.",
  }),
  "devices.setupToken.list": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ setupTokens: Type.Array(SetupTokenInfo) }),
    scope: "operator.admin",
    description: "Lists setup tokens made in the last day, newest first (never the token itself).",
  }),
  "devices.setupToken.revoke": defineMethod({
    params: Type.Object({ id: Id }),
    result: Type.Object({ setupToken: SetupTokenInfo }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Revokes a setup token that has not been used; a revoked token pairs nobody. Side-effecting.",
  }),
} as const;
