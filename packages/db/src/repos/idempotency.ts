import { and, eq, lt } from "drizzle-orm";
import { decodeJson } from "../mappers.ts";
import type { PsycheDb } from "../open.ts";
import { gatewayIdempotency } from "../schema.ts";

export interface IdempotencyRecord {
  readonly paramsHash: string;
  readonly result: unknown;
  readonly createdAt: string;
}

export interface IdempotencyKeyRef {
  readonly deviceId: string;
  readonly method: string;
  readonly key: string;
}

export function getIdempotencyRecord(
  db: PsycheDb,
  ref: IdempotencyKeyRef,
): IdempotencyRecord | undefined {
  const row = db.drizzle
    .select()
    .from(gatewayIdempotency)
    .where(
      and(
        eq(gatewayIdempotency.deviceId, ref.deviceId),
        eq(gatewayIdempotency.method, ref.method),
        eq(gatewayIdempotency.idempotencyKey, ref.key),
      ),
    )
    .get();
  return row === undefined
    ? undefined
    : {
        paramsHash: row.paramsHash,
        result: decodeJson<unknown>(row.result),
        createdAt: row.createdAt,
      };
}

/** Stores a result; call inside the mutation's transaction. A duplicate key throws. */
export function putIdempotencyRecord(
  db: PsycheDb,
  ref: IdempotencyKeyRef,
  paramsHash: string,
  result: unknown,
): void {
  db.drizzle
    .insert(gatewayIdempotency)
    .values({
      id: db.newId(),
      deviceId: ref.deviceId,
      method: ref.method,
      idempotencyKey: ref.key,
      paramsHash,
      result: JSON.stringify(result ?? null),
      createdAt: db.now(),
    })
    .run();
}

/** Drops records created before `cutoff`. */
export function pruneIdempotencyRecords(db: PsycheDb, cutoff: string): number {
  return db.drizzle.delete(gatewayIdempotency).where(lt(gatewayIdempotency.createdAt, cutoff)).run()
    .changes;
}
