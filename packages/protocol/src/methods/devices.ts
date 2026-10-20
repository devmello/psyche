import { Type } from "@sinclair/typebox";
import { DeviceScope, Id, IsoDateTime } from "../common.ts";
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
  },
  { $id: "PresenceKeyInfo" },
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
      /** When given, the helper's key id must match (the owner compares what the helper shows). */
      expectKeyId: Type.Optional(KeyId),
      /** Fresh presence: the approved `policy_change` card from a first `approval_required` call. */
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({ presenceKey: PresenceKeyInfo }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Reads the helper's Secure Enclave presence key (`presence.public_key`) and registers it for that device, so its Touch ID answers verify. Replaces an earlier key; revoked with the device. Needs fresh presence once the Gateway has a presence verifier (approval_required, then retry with approvalId; presence_required when presence was enrolled but nothing can verify now). Side-effecting.",
  }),
  "devices.presenceKey.remove": defineMethod({
    params: Type.Object({ deviceId: Id }),
    result: Type.Object({ removed: Type.Boolean() }),
    scope: "operator.admin",
    sideEffecting: true,
    description: "Removes a helper's registered presence key. Side-effecting.",
  }),
} as const;
