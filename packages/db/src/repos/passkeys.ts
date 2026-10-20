import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { PsycheDb } from "../open.ts";
import { devices, passkeys } from "../schema.ts";

export interface StoredPasskey {
  id: string;
  deviceId: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  name: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

type Row = typeof passkeys.$inferSelect;

function fromRow(row: Row): StoredPasskey {
  return {
    id: row.id,
    deviceId: row.deviceId,
    credentialId: row.credentialId,
    publicKey: new Uint8Array(row.publicKey),
    counter: row.counter,
    transports: JSON.parse(row.transports) as string[],
    name: row.name,
    backedUp: row.backedUp === 1,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

export function insertPasskey(
  db: PsycheDb,
  input: Omit<StoredPasskey, "id" | "createdAt" | "lastUsedAt"> & { id?: string },
): StoredPasskey {
  const row = db.drizzle
    .insert(passkeys)
    .values({
      id: input.id ?? db.newId(),
      deviceId: input.deviceId,
      credentialId: input.credentialId,
      publicKey: Buffer.from(input.publicKey),
      counter: input.counter,
      transports: JSON.stringify(input.transports),
      name: input.name,
      backedUp: input.backedUp ? 1 : 0,
      createdAt: db.now(),
    })
    .returning()
    .get();
  return fromRow(row);
}

export function listPasskeys(db: PsycheDb, deviceId: string): StoredPasskey[] {
  return db.drizzle
    .select()
    .from(passkeys)
    .where(eq(passkeys.deviceId, deviceId))
    .orderBy(asc(passkeys.createdAt))
    .all()
    .map(fromRow);
}

export function getPasskeyByCredential(
  db: PsycheDb,
  credentialId: string,
): StoredPasskey | undefined {
  const row = db.drizzle
    .select()
    .from(passkeys)
    .where(eq(passkeys.credentialId, credentialId))
    .get();
  return row === undefined ? undefined : fromRow(row);
}

export function recordPasskeyUse(db: PsycheDb, id: string, counter: number): void {
  db.drizzle
    .update(passkeys)
    .set({ counter, lastUsedAt: db.now() })
    .where(eq(passkeys.id, id))
    .run();
}

export function deletePasskey(db: PsycheDb, id: string, deviceId: string): boolean {
  return (
    db.drizzle
      .delete(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.deviceId, deviceId)))
      .run().changes > 0
  );
}

/** Passkeys of paired, non-revoked devices (what the presence-ready check counts). */
export function countActivePasskeys(db: PsycheDb): number {
  const row = db.drizzle
    .select({ n: sql<number>`count(*)` })
    .from(passkeys)
    .innerJoin(devices, eq(devices.id, passkeys.deviceId))
    .where(and(isNull(devices.revokedAt), isNotNull(devices.pairedAt)))
    .get();
  return row?.n ?? 0;
}
