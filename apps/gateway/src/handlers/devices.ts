import { hostname } from "node:os";
import {
  decidePairingRequest,
  deleteMachineByDevice,
  expirePairingRequests,
  getDevice,
  getDeviceFamily,
  getMachineByDevice,
  getNodeByDevice,
  getPairingRequest,
  insertMachine,
  listDevices,
  listPairingRequests,
  type PsycheDb,
  revokeDevice,
  revokeSetupTokensCreatedBy,
  setNodeStatus,
  updateDevice,
} from "@psyche/db";
import { type Device, type DeviceScope, type PairingRequest, PsycheError } from "@psyche/protocol";
import { keyFingerprint } from "../auth.ts";
import { configWarnings } from "../config.ts";
import type { Call, GatewayContext, HandlerDef, LiveConnection } from "../context.ts";
import { announceMachine, machineInfoOf, uniqueMachineName } from "../nodes/machines.ts";

/**
 * Approves a pending device pairing with owner-chosen scopes. A request whose purpose is `machine`
 * (the card "wants to let Psyche use its screen, apps, shell and files") is the one way this path
 * makes a machine: its scopes are `["node"]` whatever the caller passed, the stored decision is
 * written in the same transaction, and the device must be the node and `linux-helper` family it
 * declared when it asked. Any other request never makes one. The device's key must still be the
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
): { device: Device; request: PairingRequest; machineId?: string } {
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
  const machine = request.purpose === "machine";
  if (machine) assertMachineCandidate(db, device);
  const decided = decidePairingRequest(db, request.id, {
    decision: "approved",
    decidedByDeviceId: input.decidedByDeviceId,
  });
  const done = applyPairingDecision(db, {
    device,
    machine,
    scopes: input.scopes,
    pairedAt: db.now(),
    decidedByDeviceId: input.decidedByDeviceId,
  });
  return {
    device: done.device,
    request: decided,
    ...(done.machineId === undefined ? {} : { machineId: done.machineId.machineId }),
  };
}

/** A machine request is from a node in the `linux-helper` family, as the card said. */
function assertMachineCandidate(db: PsycheDb, device: Device): void {
  if (device.role !== "node" || getDeviceFamily(db, device.id) !== "linux-helper") {
    throw new PsycheError("conflict", "That request is not from a Linux helper node");
  }
}

/**
 * The one place a pairing decision turns into a paired device, for all three ways the owner
 * decides: the card (`devices.approve`), the first-admin CLI shortcut, and a recovery that applies
 * after the card expired (`security/recoveries.ts`). For a machine request the scopes the caller
 * passed are ignored: they are `["node"]`, the role and family are checked again, the name is a
 * unique machine name, and the stored decision is written in the same transaction. Any other
 * request gets the scopes it was given and never makes a machine.
 */
export function applyPairingDecision(
  db: PsycheDb,
  input: {
    device: Device;
    machine: boolean;
    scopes: readonly DeviceScope[];
    pairedAt: string;
    decidedByDeviceId: string | null;
  },
): { device: Device; machineId?: { machineId: string } } {
  const { device, machine } = input;
  if (machine) assertMachineCandidate(db, device);
  const scopes: DeviceScope[] = machine ? ["node"] : [...new Set(input.scopes)];
  const updated = updateDevice(db, device.id, {
    scopes,
    pairedAt: input.pairedAt,
    ...(machine ? { name: uniqueMachineName(db, device.name, device.id) } : {}),
  });
  if (!updated) throw new PsycheError("not_found", "device not found");
  if (!machine) return { device: updated };
  const record = insertMachine(db, {
    deviceId: device.id,
    approvedByDeviceId: input.decidedByDeviceId,
    via: "pairing_card",
  });
  return { device: updated, machineId: { machineId: record.id } };
}

function closeDeviceConnections(
  ctx: GatewayContext,
  deviceId: string,
  reason: string,
  /** The connection making the call: it closes after its reply, not before it. */
  caller?: LiveConnection,
): void {
  for (const conn of [...ctx.connections()]) {
    if (conn.identity?.deviceId === deviceId || conn.pendingDeviceId === deviceId) {
      if (conn === caller && conn.closeAfterReply) conn.closeAfterReply(reason);
      else conn.close(reason);
    }
  }
}

/**
 * The shared body of `devices.revoke` and `devices.revokeSelf`. The calling connection, when it
 * belongs to the revoked device, closes after its reply instead of before it.
 */
function revokeNow(call: Call, deviceId: string): Device {
  const { db } = call.ctx;
  // A machine's snapshot is taken before its row goes, for the event and the audit entry.
  const machineRow = getMachineByDevice(db, deviceId);
  const removedMachine = machineRow === undefined ? undefined : machineInfoOf(db, machineRow);
  const device = revokeDevice(db, deviceId);
  if (!device) throw new PsycheError("not_found", `device ${deviceId} not found`);
  // The owner's decision ends with the device: no machine row survives it, in the same transaction.
  if (machineRow !== undefined) deleteMachineByDevice(db, device.id);
  // Security §10: revoking a device revokes its token and node authority permanently.
  const node = getNodeByDevice(db, device.id);
  const offline = node ? setNodeStatus(db, node.id, "offline") : undefined;
  // A pairing link it made but nobody used yet dies with it (same transaction).
  revokeSetupTokensCreatedBy(db, device.id);
  call.ctx.bus.bumpStateVersion();
  call.emit("device.updated", { device });
  if (offline) call.emit("node.updated", { node: offline });
  if (machineRow !== undefined && removedMachine !== undefined) {
    call.emit("machines.changed", {
      machine: { ...removedMachine, status: "offline" },
      change: "removed",
    });
  }
  call.afterCommit(() => {
    if (machineRow !== undefined) {
      call.ctx.onMachineChange?.({
        change: "removed",
        machineId: machineRow.id,
        deviceId: device.id,
        name: removedMachine?.name ?? device.name,
        byDeviceId: call.identity.deviceId,
      });
    }
    closeDeviceConnections(call.ctx, device.id, "device revoked", call.conn);
    // Grants the device approved end with it (design-28). Failure is logged, not fatal: the
    // device is already revoked and cannot use them.
    call.ctx.onDeviceRevoked?.(device.id).catch((err) =>
      call.ctx.log.log("warn", "grant revocation for a revoked device failed", {
        code: PsycheError.from(err).code,
      }),
    );
  });
  return device;
}

export const devicesHandlers: Record<string, HandlerDef> = {
  "gateway.info": {
    run(call: Call) {
      const { identity, config } = call.ctx;
      return {
        identity: { publicKey: identity.publicKey, fingerprint: identity.fingerprint },
        hostName: hostname(),
        publicOrigin: config.publicOrigin,
        trustedProxy: config.trustedProxy.enabled,
        ...(call.identity.scopes.includes("operator.admin") && configWarnings().length > 0
          ? { configWarnings: configWarnings().slice(0, 50) }
          : {}),
        // The list of this Host's interfaces and addresses is for admins; others see the rest.
        lan: {
          ...call.ctx.lan.status(),
          candidates: call.identity.scopes.includes("operator.admin")
            ? call.ctx.lan.status().candidates
            : [],
        },
      };
    },
  },
  "gateway.lan.rotateCert": {
    async run(call: Call) {
      const status = await call.ctx.lan.rotateCert();
      if (status.certSpki === null) {
        throw new PsycheError("unavailable", "LAN listening is not running; turn it on first");
      }
      // The new certificate is a new pin: every client that pinned the old one pairs again.
      call.ctx.log.log("warn", "lan certificate rotated", { by: call.identity.deviceId });
      return { certSpki: status.certSpki };
    },
  },
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
      const { device, machineId } = approvePairing(call.ctx.db, {
        pairingRequestId: params.pairingRequestId,
        scopes: params.scopes,
        ...(params.code === undefined ? {} : { code: params.code }),
        decidedByDeviceId: call.identity.deviceId,
      });
      call.ctx.bus.bumpStateVersion();
      call.emit("device.updated", { device });
      // The owner's tap is the moment a machine is added: every device hears it now, once.
      const record =
        machineId === undefined ? undefined : getMachineByDevice(call.ctx.db, device.id);
      if (record !== undefined) {
        announceMachine(
          call.ctx.db,
          record,
          (machine) => call.emit("machines.changed", { machine, change: "added" }),
          (change) => call.afterCommit(() => call.ctx.onMachineChange?.(change)),
        );
      }
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
      return { device: revokeNow(call, params.deviceId) };
    },
  },
  "node.unpair": {
    transactional: true,
    run(call: Call) {
      // Only a connection the Gateway paired as a machine (from the sealed decision at this
      // connect), and only its own device: the method takes no id.
      if (call.identity.machine !== true || call.identity.role !== "node") {
        throw new PsycheError("forbidden", "Only a paired machine can unpair itself");
      }
      return { device: revokeNow(call, call.identity.deviceId) };
    },
  },
  "devices.revokeSelf": {
    transactional: true,
    run(call: Call) {
      // Only ever the caller's own id: the method takes no parameter that could name another.
      const device = revokeNow(call, call.identity.deviceId);
      call.afterCommit(() =>
        call.ctx.onDeviceSelfRevoked?.({ deviceId: device.id, name: device.name }),
      );
      return { device };
    },
  },
};
