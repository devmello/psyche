import type { Device, DevicePlatform, DeviceRole, DeviceScope } from "@psyche/protocol";
import { and, asc, eq, isNull } from "drizzle-orm";
import { deviceFromRow } from "../mappers.ts";
import type { PsycheDb } from "../open.ts";
import { devices } from "../schema.ts";

export interface NewDevice {
  readonly id?: string;
  readonly name: string;
  readonly platform: DevicePlatform;
  readonly role: DeviceRole;
  /** Raw Ed25519 public key bytes, or its base64url encoding (the wire form). */
  readonly publicKey: Uint8Array | string;
  /** Hash of the device token; never the token itself. */
  readonly tokenHash?: Uint8Array | null;
  readonly scopes?: readonly DeviceScope[];
  /** `null` while a pairing request is pending. */
  readonly pairedAt?: string | null;
}

function keyBytes(key: Uint8Array | string): Buffer {
  return typeof key === "string" ? Buffer.from(key, "base64url") : Buffer.from(key);
}

export function insertDevice(db: PsycheDb, input: NewDevice): Device {
  const at = db.now();
  const row = db.drizzle
    .insert(devices)
    .values({
      id: input.id ?? db.newId(),
      name: input.name,
      platform: input.platform,
      role: input.role,
      publicKey: keyBytes(input.publicKey),
      tokenHash: input.tokenHash == null ? null : Buffer.from(input.tokenHash),
      scopes: JSON.stringify(input.scopes ?? []),
      pairedAt: input.pairedAt ?? null,
      createdAt: at,
      updatedAt: at,
    })
    .returning()
    .get();
  return deviceFromRow(row);
}

export function getDevice(db: PsycheDb, id: string): Device | undefined {
  const row = db.drizzle.select().from(devices).where(eq(devices.id, id)).get();
  return row === undefined ? undefined : deviceFromRow(row);
}

export function listDevices(db: PsycheDb, opts: { includeRevoked?: boolean } = {}): Device[] {
  const query = db.drizzle.select().from(devices);
  const rows = opts.includeRevoked
    ? query.orderBy(asc(devices.createdAt)).all()
    : query.where(isNull(devices.revokedAt)).orderBy(asc(devices.createdAt)).all();
  return rows.map(deviceFromRow);
}

/** Revokes a device and drops its token hash. Idempotent; `undefined` if the device is unknown. */
export function revokeDevice(db: PsycheDb, id: string): Device | undefined {
  const at = db.now();
  const existing = db.drizzle.select().from(devices).where(eq(devices.id, id)).get();
  if (existing === undefined) return undefined;
  if (existing.revokedAt !== null) return deviceFromRow(existing);
  const row = db.drizzle
    .update(devices)
    .set({ revokedAt: at, tokenHash: null, updatedAt: at })
    .where(eq(devices.id, id))
    .returning()
    .get();
  return row === undefined ? undefined : deviceFromRow(row);
}

/** Records activity; does not bump `updated_at` (presence is not an edit). */
export function touchLastSeen(db: PsycheDb, id: string, at: string = db.now()): boolean {
  return (
    db.drizzle.update(devices).set({ lastSeenAt: at }).where(eq(devices.id, id)).run().changes > 0
  );
}

export interface DevicePatch {
  readonly name?: string;
  readonly publicKey?: Uint8Array | string;
  readonly role?: DeviceRole;
  readonly scopes?: readonly DeviceScope[];
  readonly pairedAt?: string | null;
}

/** Updates a device that is not revoked; `undefined` if it is unknown or revoked. */
export function updateDevice(db: PsycheDb, id: string, patch: DevicePatch): Device | undefined {
  const set: Partial<typeof devices.$inferInsert> = { updatedAt: db.now() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.publicKey !== undefined) set.publicKey = keyBytes(patch.publicKey);
  if (patch.role !== undefined) set.role = patch.role;
  if (patch.scopes !== undefined) set.scopes = JSON.stringify(patch.scopes);
  if (patch.pairedAt !== undefined) set.pairedAt = patch.pairedAt;
  const row = db.drizzle
    .update(devices)
    .set(set)
    .where(and(eq(devices.id, id), isNull(devices.revokedAt)))
    .returning()
    .get();
  return row === undefined ? undefined : deviceFromRow(row);
}
