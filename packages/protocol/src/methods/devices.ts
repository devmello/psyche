import { Type } from "@sinclair/typebox";
import { DeviceScope, Id } from "../common.ts";
import { Device, PairingRequest, PairingStatus } from "../schemas/identity.ts";
import { defineMethod } from "./define.ts";

/** `devices.*`: pairing and device management; every method needs `operator.admin` (security §10). */

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
    }),
    result: Type.Object({ device: Device }),
    scope: "operator.admin",
    description: "Approves a pending pairing request with owner-chosen scopes.",
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
} as const;
