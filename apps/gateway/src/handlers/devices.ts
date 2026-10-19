import {
  decidePairingRequest,
  expirePairingRequests,
  getDevice,
  getNodeByDevice,
  getPairingRequest,
  listDevices,
  listPairingRequests,
  type PsycheDb,
  revokeDevice,
  setNodeStatus,
  updateDevice,
} from "@psyche/db";
import { type Device, type DeviceScope, type PairingRequest, PsycheError } from "@psyche/protocol";
import { keyFingerprint } from "../auth.ts";
import type { Call, GatewayContext, HandlerDef } from "../context.ts";

/**
 * Approves a pending device pairing with owner-chosen scopes. The device's key must still be the
 * one the request was created for (S23 review PR-1-B), and `code`, when given, must match the
 * code the new device shows. Shared by `devices.approve` and `psyched devices approve`.
 */
export function approvePairing(
  db: PsycheDb,
  input: {
    pairingRequestId: string;
    scopes: DeviceScope[];
    code?: string;
    decidedByDeviceId: string | null;
  },
): { device: Device; request: PairingRequest } {
  const request = getPairingRequest(db, input.pairingRequestId);
  if (request?.kind !== "device" || !request.deviceId) {
    throw new PsycheError("not_found", `pairing request ${input.pairingRequestId} not found`);
  }
  if (input.code !== undefined && input.code.toUpperCase() !== request.code) {
    throw new PsycheError("forbidden", "The code does not match the one shown on the device");
  }
  const device = getDevice(db, request.deviceId);
  if (!device || device.revokedAt) throw new PsycheError("not_found", "device not found");
  if (
    request.publicKeyFingerprint &&
    keyFingerprint(device.publicKey) !== request.publicKeyFingerprint
  ) {
    throw new PsycheError("conflict", "The device key changed since the request was created");
  }
  const decided = decidePairingRequest(db, request.id, {
    decision: "approved",
    decidedByDeviceId: input.decidedByDeviceId,
  });
  const scopes = [...new Set(input.scopes)];
  const updated = updateDevice(db, device.id, { scopes, pairedAt: db.now() });
  if (!updated) throw new PsycheError("not_found", "device not found");
  return { device: updated, request: decided };
}

function closeDeviceConnections(ctx: GatewayContext, deviceId: string, reason: string): void {
  for (const conn of [...ctx.connections()]) {
    if (conn.identity?.deviceId === deviceId || conn.pendingDeviceId === deviceId)
      conn.close(reason);
  }
}

export const devicesHandlers: Record<string, HandlerDef> = {
  "devices.list": {
    run(call: Call, params: { includeRevoked?: boolean }) {
      return {
        devices: listDevices(call.ctx.db, { includeRevoked: params.includeRevoked ?? false }),
      };
    },
  },
  "devices.pairing.list": {
    run(call: Call, params: { status?: PairingRequest["status"] }) {
      expirePairingRequests(call.ctx.db);
      return {
        pairingRequests: listPairingRequests(call.ctx.db, { status: params.status ?? "pending" }),
      };
    },
  },
  "devices.approve": {
    transactional: true,
    run(call: Call, params: { pairingRequestId: string; scopes: DeviceScope[]; code?: string }) {
      const { device } = approvePairing(call.ctx.db, {
        pairingRequestId: params.pairingRequestId,
        scopes: params.scopes,
        ...(params.code === undefined ? {} : { code: params.code }),
        decidedByDeviceId: call.identity.deviceId,
      });
      call.ctx.bus.bumpStateVersion();
      call.emit("device.updated", { device });
      // The pending connection re-handshakes to pick up its scopes.
      call.afterCommit(() =>
        closeDeviceConnections(call.ctx, device.id, "pairing approved; reconnect"),
      );
      return { device };
    },
  },
  "devices.deny": {
    transactional: true,
    run(call: Call, params: { pairingRequestId: string }) {
      const pairingRequest = decidePairingRequest(call.ctx.db, params.pairingRequestId, {
        decision: "denied",
        decidedByDeviceId: call.identity.deviceId,
      });
      call.ctx.bus.bumpStateVersion();
      const deviceId = pairingRequest.deviceId;
      if (deviceId)
        call.afterCommit(() => closeDeviceConnections(call.ctx, deviceId, "pairing denied"));
      return { pairingRequest };
    },
  },
  "devices.revoke": {
    transactional: true,
    run(call: Call, params: { deviceId: string }) {
      const { db } = call.ctx;
      const device = revokeDevice(db, params.deviceId);
      if (!device) throw new PsycheError("not_found", `device ${params.deviceId} not found`);
      // Security §10: revoking a device revokes its token and node authority permanently.
      const node = getNodeByDevice(db, device.id);
      const offline = node ? setNodeStatus(db, node.id, "offline") : undefined;
      call.ctx.bus.bumpStateVersion();
      call.emit("device.updated", { device });
      if (offline) call.emit("node.updated", { node: offline });
      call.afterCommit(() => {
        closeDeviceConnections(call.ctx, device.id, "device revoked");
        // Grants the device approved end with it (design-28). Failure is logged, not fatal: the
        // device is already revoked and cannot use them.
        call.ctx.onDeviceRevoked?.(device.id).catch((err) =>
          call.ctx.log.log("warn", "grant revocation for a revoked device failed", {
            code: PsycheError.from(err).code,
          }),
        );
      });
      return { device };
    },
  },
};
