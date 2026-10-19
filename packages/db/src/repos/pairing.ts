import type { PairingRequest } from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import { and, eq, lte } from "drizzle-orm";
import { pairingRequestFromRow } from "../mappers.ts";
import type { PsycheDb } from "../open.ts";
import { pairingRequests } from "../schema.ts";

/** Default pairing request lifetime. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

export interface NewPairingRequest {
  readonly id?: string;
  readonly kind: PairingRequest["kind"];
  readonly code: string;
  readonly deviceId?: string | null;
  readonly channelId?: string | null;
  readonly senderId?: string | null;
  readonly display: string;
  /** Absolute expiry; default `now + PAIRING_TTL_MS`. */
  readonly expiresAt?: string;
}

/** Normalizes any parseable timestamp to `Date#toISOString` so string comparison is ordering. */
function iso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`invalid timestamp: ${value}`);
  return date.toISOString();
}

export function createPairingRequest(db: PsycheDb, input: NewPairingRequest): PairingRequest {
  const at = db.now();
  const expiresAt =
    input.expiresAt === undefined
      ? new Date(new Date(at).getTime() + PAIRING_TTL_MS).toISOString()
      : iso(input.expiresAt);
  const row = db.drizzle
    .insert(pairingRequests)
    .values({
      id: input.id ?? db.newId(),
      kind: input.kind,
      code: input.code,
      deviceId: input.deviceId ?? null,
      channelId: input.channelId ?? null,
      senderId: input.senderId ?? null,
      display: input.display,
      status: "pending",
      expiresAt,
      createdAt: at,
      updatedAt: at,
    })
    .returning()
    .get();
  return pairingRequestFromRow(row);
}

export function getPairingRequest(db: PsycheDb, id: string): PairingRequest | undefined {
  const row = db.drizzle.select().from(pairingRequests).where(eq(pairingRequests.id, id)).get();
  return row === undefined ? undefined : pairingRequestFromRow(row);
}

export interface PairingDecision {
  readonly decision: "approved" | "denied";
  readonly decidedByDeviceId?: string | null;
}

/**
 * Approves or denies a pending request. Throws `not_found` for an unknown id and `conflict` when
 * the request was already decided or has expired (an expired request is marked `expired` first).
 */
export function decidePairingRequest(
  db: PsycheDb,
  id: string,
  decision: PairingDecision,
): PairingRequest {
  const outcome = db.sqlite
    .transaction(() => {
      const row = db.drizzle.select().from(pairingRequests).where(eq(pairingRequests.id, id)).get();
      if (row === undefined) return { kind: "not_found" as const };
      if (row.status !== "pending") return { kind: "decided" as const, status: row.status };
      const at = db.now();
      if (row.expiresAt <= at) {
        db.drizzle
          .update(pairingRequests)
          .set({ status: "expired", updatedAt: at })
          .where(eq(pairingRequests.id, id))
          .run();
        return { kind: "expired" as const };
      }
      const updated = db.drizzle
        .update(pairingRequests)
        .set({
          status: decision.decision,
          decidedAt: at,
          decidedByDeviceId: decision.decidedByDeviceId ?? null,
          updatedAt: at,
        })
        .where(eq(pairingRequests.id, id))
        .returning()
        .get();
      return { kind: "ok" as const, row: updated };
    })
    .immediate();

  switch (outcome.kind) {
    case "not_found":
      throw new PsycheError("not_found", `pairing request ${id} not found`);
    case "decided":
      throw new PsycheError("conflict", `pairing request ${id} is already ${outcome.status}`);
    case "expired":
      throw new PsycheError("conflict", `pairing request ${id} has expired`);
    case "ok":
      if (outcome.row === undefined)
        throw new PsycheError("not_found", `pairing request ${id} not found`);
      return pairingRequestFromRow(outcome.row);
  }
}

/** Marks pending requests whose `expires_at <= now` as expired. Returns how many changed. */
export function expirePairingRequests(db: PsycheDb, now: string = db.now()): number {
  const cutoff = iso(now);
  return db.drizzle
    .update(pairingRequests)
    .set({ status: "expired", updatedAt: db.now() })
    .where(and(eq(pairingRequests.status, "pending"), lte(pairingRequests.expiresAt, cutoff)))
    .run().changes;
}
