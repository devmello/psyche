import { createHash } from "node:crypto";
import type { PairingRequest } from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import { and, desc, eq, gt, gte, lte, sql } from "drizzle-orm";
import { pairingRequestFromRow } from "../mappers.ts";
import type { PsycheDb } from "../open.ts";
import { pairingRequests, pairingSetupTokens } from "../schema.ts";

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
  /** Device requests: `sha256:<hex>` of the raw public key the owner approves. */
  readonly publicKeyFingerprint?: string | null;
  readonly transport?: "ws" | "unix" | null;
  readonly remoteAddress?: string | null;
  /** Device requests: the device presented a valid pairing-link setup token. */
  readonly viaSetupToken?: boolean;
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
      publicKeyFingerprint: input.publicKeyFingerprint ?? null,
      transport: input.transport ?? null,
      remoteAddress: input.remoteAddress ?? null,
      viaSetupToken: input.viaSetupToken === true ? 1 : 0,
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

export function listPairingRequests(
  db: PsycheDb,
  opts: { status?: PairingRequest["status"] } = {},
): PairingRequest[] {
  return db.drizzle
    .select()
    .from(pairingRequests)
    .where(opts.status === undefined ? undefined : eq(pairingRequests.status, opts.status))
    .orderBy(desc(pairingRequests.createdAt))
    .all()
    .map(pairingRequestFromRow);
}

/** The live pending request of a device, if any. */
export function findPendingPairingForDevice(
  db: PsycheDb,
  deviceId: string,
  now: string = db.now(),
): PairingRequest | undefined {
  const row = db.drizzle
    .select()
    .from(pairingRequests)
    .where(
      and(
        eq(pairingRequests.deviceId, deviceId),
        eq(pairingRequests.status, "pending"),
        gt(pairingRequests.expiresAt, iso(now)),
      ),
    )
    .orderBy(desc(pairingRequests.createdAt))
    .limit(1)
    .get();
  return row === undefined ? undefined : pairingRequestFromRow(row);
}

export function expirePendingPairingsForDevice(db: PsycheDb, deviceId: string): number {
  const at = db.now();
  return db.drizzle
    .update(pairingRequests)
    .set({ status: "expired", decidedAt: at, updatedAt: at })
    .where(and(eq(pairingRequests.deviceId, deviceId), eq(pairingRequests.status, "pending")))
    .run().changes;
}

export function countPendingPairings(db: PsycheDb, now: string = db.now()): number {
  const row = db.drizzle
    .select({ n: sql<number>`count(*)` })
    .from(pairingRequests)
    .where(and(eq(pairingRequests.status, "pending"), gt(pairingRequests.expiresAt, iso(now))))
    .get();
  return row?.n ?? 0;
}

/** Pairing requests created from `remoteAddress` since `since` (rate limit, security §10). */
export function countPairingsFromAddress(
  db: PsycheDb,
  remoteAddress: string,
  since: string,
): number {
  const row = db.drizzle
    .select({ n: sql<number>`count(*)` })
    .from(pairingRequests)
    .where(
      and(
        eq(pairingRequests.remoteAddress, remoteAddress),
        gte(pairingRequests.createdAt, iso(since)),
      ),
    )
    .get();
  return row?.n ?? 0;
}

// Setup tokens (pairing links) ---------------------------------------------------------------

/** SHA-256 hex of a setup token: the only form that is stored or compared. */
export function hashSetupToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Stores the hash of a new token that expires at `expiresAt`. Returns the row id. */
export function createSetupToken(
  db: PsycheDb,
  input: { tokenHash: string; expiresAt: string; createdByDeviceId: string | null },
): string {
  const at = db.now();
  const id = db.newId();
  db.drizzle
    .insert(pairingSetupTokens)
    .values({
      id,
      tokenHash: input.tokenHash,
      createdByDeviceId: input.createdByDeviceId,
      createdAt: at,
      expiresAt: iso(input.expiresAt),
    })
    .run();
  return id;
}

export type SetupTokenUse =
  | { ok: true; id: string }
  | { ok: false; reason: "unknown" | "expired" | "used" };

/**
 * Consumes a setup token for `deviceId`, atomically: the update only matches an unused, unexpired
 * row, so two connects racing with the same token cannot both win. Call inside the transaction
 * that creates the pairing request, so a failure after this rolls the use back.
 */
export function consumeSetupToken(
  db: PsycheDb,
  token: string,
  deviceId: string,
  now: string = db.now(),
): SetupTokenUse {
  const at = iso(now);
  const hash = hashSetupToken(token);
  const won = db.drizzle
    .update(pairingSetupTokens)
    .set({ usedAt: at, usedByDeviceId: deviceId })
    .where(
      and(
        eq(pairingSetupTokens.tokenHash, hash),
        sql`${pairingSetupTokens.usedAt} IS NULL`,
        gt(pairingSetupTokens.expiresAt, at),
      ),
    )
    .returning({ id: pairingSetupTokens.id })
    .get();
  if (won !== undefined) return { ok: true, id: won.id };
  const row = db.drizzle
    .select()
    .from(pairingSetupTokens)
    .where(eq(pairingSetupTokens.tokenHash, hash))
    .get();
  if (row === undefined) return { ok: false, reason: "unknown" };
  return { ok: false, reason: row.usedAt === null ? "expired" : "used" };
}

/** Deletes tokens that expired over a day ago (used or not). Returns how many went. */
export function purgeSetupTokens(db: PsycheDb, now: string = db.now()): number {
  const cutoff = new Date(new Date(iso(now)).getTime() - 24 * 3_600_000).toISOString();
  return db.drizzle
    .delete(pairingSetupTokens)
    .where(lte(pairingSetupTokens.expiresAt, cutoff))
    .run().changes;
}
