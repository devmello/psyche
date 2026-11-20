import { and, asc, eq, isNull } from "drizzle-orm";
import type { PsycheDb } from "../open.ts";
import { readGuardOf } from "../read-guard.ts";
import { devices, type MachineRow, machines } from "../schema.ts";

/**
 * The owner's stored decision that a device is a machine (docs/design/linux-helper-only-2026.md
 * section 6.1). Reads go through the seal's guard like the device rows they authorize: a row the
 * Gateway cannot vouch for decides nothing.
 */

export type MachineVia = "setup_token" | "pairing_card";

export interface MachineRecord {
  id: string;
  deviceId: string;
  approvedAt: string;
  approvedByDeviceId: string | null;
  via: MachineVia;
  announcedAt: string | null;
}

function toRecord(row: MachineRow): MachineRecord {
  return {
    id: row.id,
    deviceId: row.deviceId,
    approvedAt: row.approvedAt,
    approvedByDeviceId: row.approvedByDeviceId,
    via: row.via as MachineVia,
    announcedAt: row.announcedAt,
  };
}

/** Records the decision. A device already named keeps its first row (the call is idempotent). */
export function insertMachine(
  db: PsycheDb,
  input: { deviceId: string; approvedByDeviceId: string | null; via: MachineVia; id?: string },
): MachineRecord {
  const row = db.drizzle
    .insert(machines)
    .values({
      id: input.id ?? db.newId(),
      deviceId: input.deviceId,
      approvedAt: db.now(),
      approvedByDeviceId: input.approvedByDeviceId,
      via: input.via,
    })
    .onConflictDoNothing({ target: machines.deviceId })
    .returning()
    .get();
  if (row !== undefined) return toRecord(row);
  const existing = db.drizzle
    .select()
    .from(machines)
    .where(eq(machines.deviceId, input.deviceId))
    .get();
  if (existing === undefined) throw new Error("machine row vanished");
  return toRecord(existing);
}

export function getMachineByDevice(db: PsycheDb, deviceId: string): MachineRecord | undefined {
  const guard = readGuardOf(db);
  guard?.check();
  const row = db.drizzle.select().from(machines).where(eq(machines.deviceId, deviceId)).get();
  if (row === undefined) return undefined;
  if (guard?.genuine?.("machines", row.id) === false) return undefined;
  return toRecord(row);
}

export function getMachine(db: PsycheDb, id: string): MachineRecord | undefined {
  const guard = readGuardOf(db);
  guard?.check();
  const row = db.drizzle.select().from(machines).where(eq(machines.id, id)).get();
  if (row === undefined) return undefined;
  if (guard?.genuine?.("machines", row.id) === false) return undefined;
  return toRecord(row);
}

/** Machines whose device is paired and not revoked, oldest first. */
export function listMachines(db: PsycheDb): MachineRecord[] {
  const guard = readGuardOf(db);
  guard?.check();
  return db.drizzle
    .select({ machine: machines })
    .from(machines)
    .innerJoin(devices, eq(devices.id, machines.deviceId))
    .where(isNull(devices.revokedAt))
    .orderBy(asc(machines.approvedAt), asc(machines.id))
    .all()
    .filter((r) => guard?.genuine?.("machines", r.machine.id) !== false)
    .map((r) => toRecord(r.machine));
}

/** Removes the decision (the device was revoked). Returns whether a row went. */
export function deleteMachineByDevice(db: PsycheDb, deviceId: string): boolean {
  return db.drizzle.delete(machines).where(eq(machines.deviceId, deviceId)).run().changes > 0;
}

/**
 * Marks the "added" notice as sent. One conditional UPDATE, so of two connections racing on the
 * first attach only one gets `true`.
 */
export function markMachineAnnounced(db: PsycheDb, deviceId: string): boolean {
  return (
    db.drizzle
      .update(machines)
      .set({ announcedAt: db.now() })
      .where(and(eq(machines.deviceId, deviceId), isNull(machines.announcedAt)))
      .run().changes > 0
  );
}
