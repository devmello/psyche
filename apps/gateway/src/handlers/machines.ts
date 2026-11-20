import { getDevice, getMachine, listMachines, updateDevice } from "@psyche/db";
import { type MachineInfo, machineNameOk, PsycheError } from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import { machineInfoOf, machineNameTaken } from "../nodes/machines.ts";

/**
 * `machines.*` (docs/design/linux-helper-only-2026.md sections 8.2, 9; wave H3). A machine is
 * added only by pairing and removed only by `devices.revoke`; nothing here creates or deletes
 * one, and nothing takes a node or a device id from the caller to turn it into one.
 */
export const machinesHandlers: Record<string, HandlerDef> = {
  "machines.list": {
    run(call: Call): { machines: MachineInfo[] } {
      const machines: MachineInfo[] = [];
      for (const record of listMachines(call.ctx.db)) {
        const info = machineInfoOf(call.ctx.db, record);
        if (info !== undefined) machines.push(info);
      }
      return { machines };
    },
  },
  "machines.rename": {
    transactional: true,
    run(call: Call, params: { id: string; name: string }): { machine: MachineInfo } {
      const { db } = call.ctx;
      // The schema pattern alone lets a lone surrogate through; the code point check is the rule.
      if (!machineNameOk(params.name)) {
        throw new PsycheError("invalid_params", "That is not a name a computer can have");
      }
      const record = getMachine(db, params.id);
      const device = record === undefined ? undefined : getDevice(db, record.deviceId);
      if (record === undefined || device === undefined || device.revokedAt) {
        throw new PsycheError("not_found", `machine ${params.id} not found`);
      }
      // Names match case-insensitively and two machines cannot share one (design 8.2).
      if (machineNameTaken(db, params.name, record.deviceId)) {
        throw new PsycheError("conflict", "That name is taken or reserved");
      }
      if (device.name !== params.name) {
        if (updateDevice(db, device.id, { name: params.name }) === undefined) {
          throw new PsycheError("not_found", `machine ${params.id} not found`);
        }
      }
      const machine = machineInfoOf(db, record);
      if (machine === undefined)
        throw new PsycheError("not_found", `machine ${params.id} not found`);
      call.ctx.bus.bumpStateVersion();
      call.emit("machines.changed", { machine, change: "updated" });
      if (device.name !== params.name) {
        call.afterCommit(() =>
          call.ctx.onMachineChange?.({
            change: "renamed",
            machineId: record.id,
            deviceId: device.id,
            name: params.name,
            previousName: device.name,
            byDeviceId: call.identity.deviceId,
          }),
        );
      }
      return { machine };
    },
  },
};
