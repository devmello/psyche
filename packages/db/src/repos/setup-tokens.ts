import { createHash, randomBytes } from "node:crypto";
import type { DeviceScope, SetupTokenScope } from "@psyche/protocol";
import { PsycheError, SETUP_TOKEN_TTL_MS } from "@psyche/protocol";
import { and, desc, eq, gt, gte, isNull, lt, or, sql } from "drizzle-orm";
import type { PsycheDb } from "../open.ts";
import { type SetupTokenRow, setupTokens } from "../schema.ts";

/**
 * One-time setup tokens (remote-gateway design §3.4). The token is `pst_` + 32 random bytes; only
 * its SHA-256 is stored. A token is live from creation until `expires_at` (ten minutes, exclusive:
 * at that instant it is already refused), is spent by one conditional UPDATE, and can be revoked
 * until then.
 */

/** Live (unused, unexpired, unrevoked) tokens at once: a few, so a stray link is not forgotten. */
export const MAX_LIVE_SETUP_TOKENS = 3;

/** What a token can grant: never `node`. */
export const SETUP_TOKEN_SCOPES: readonly SetupTokenScope[] = [
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.admin",
];

function isTokenScope(scope: DeviceScope): scope is SetupTokenScope {
  return (SETUP_TOKEN_SCOPES as readonly string[]).includes(scope);
}

export interface SetupTokenRecord {
  id: string;
  scopes: SetupTokenScope[];
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedByDeviceId: string | null;
  revokedAt: string | null;
  status: "live" | "used" | "expired" | "revoked";
}

/** Hex SHA-256 of the token as presented. */
export function hashSetupToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function toRecord(row: SetupTokenRow, now: string): SetupTokenRecord {
  const scopes = (JSON.parse(row.scopes) as DeviceScope[]).filter(isTokenScope);
  const status =
    row.revokedAt !== null
      ? "revoked"
      : row.usedAt !== null
        ? "used"
        : row.expiresAt <= now
          ? "expired"
          : "live";
  return {
    id: row.id,
    scopes,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    usedByDeviceId: row.usedByDeviceId,
    revokedAt: row.revokedAt,
    status,
  };
}

/**
 * Makes a token. Returns the token (the only time it exists in the clear) and its record. Refuses
 * the scope `node`, an empty list, and a live token beyond `MAX_LIVE_SETUP_TOKENS`.
 */
export function createSetupToken(
  db: PsycheDb,
  input: { scopes: readonly DeviceScope[]; createdByDeviceId?: string | null; ttlMs?: number },
): { token: string; record: SetupTokenRecord } {
  const requested = [...new Set(input.scopes)];
  const scopes = requested.filter(isTokenScope);
  if (scopes.length === 0 || scopes.length !== requested.length) {
    throw new PsycheError("invalid_params", "A setup token grants operator scopes only");
  }
  const token = `pst_${randomBytes(32).toString("base64url")}`;
  return db.sqlite
    .transaction(() => {
      const now = db.now();
      pruneSetupTokens(db, now);
      const live = db.drizzle
        .select({ n: sql<number>`count(*)` })
        .from(setupTokens)
        .where(
          and(
            isNull(setupTokens.usedAt),
            isNull(setupTokens.revokedAt),
            gt(setupTokens.expiresAt, now),
          ),
        )
        .get();
      if ((live?.n ?? 0) >= MAX_LIVE_SETUP_TOKENS) {
        throw new PsycheError(
          "rate_limited",
          "Too many unused setup tokens; revoke one or wait for it to expire",
        );
      }
      const row = db.drizzle
        .insert(setupTokens)
        .values({
          id: db.newId(),
          tokenHash: hashSetupToken(token),
          scopes: JSON.stringify(scopes),
          createdByDeviceId: input.createdByDeviceId ?? null,
          createdAt: now,
          expiresAt: new Date(
            new Date(now).getTime() + (input.ttlMs ?? SETUP_TOKEN_TTL_MS),
          ).toISOString(),
        })
        .returning()
        .get();
      return { token, record: toRecord(row, now) };
    })
    .immediate();
}

/** Deletes tokens that were used, revoked or expired more than a day ago. */
export function pruneSetupTokens(db: PsycheDb, now: string = db.now()): number {
  const cutoff = new Date(new Date(now).getTime() - 24 * 3_600_000).toISOString();
  return db.drizzle
    .delete(setupTokens)
    .where(
      and(
        lt(setupTokens.createdAt, cutoff),
        or(
          lt(setupTokens.expiresAt, cutoff),
          sql`${setupTokens.usedAt} IS NOT NULL`,
          sql`${setupTokens.revokedAt} IS NOT NULL`,
        ),
      ),
    )
    .run().changes;
}

/**
 * Spends a token for `deviceId`: succeeds only for a token that exists, is unused, unrevoked and
 * not yet expired, and then marks it used in the same statement, so a second caller (or a retry)
 * gets `undefined`. Returns the scopes it was made with.
 */
export function consumeSetupToken(
  db: PsycheDb,
  token: string,
  deviceId: string,
  now: string = db.now(),
): { id: string; scopes: SetupTokenScope[] } | undefined {
  const at = new Date(now).toISOString();
  const row = db.drizzle
    .update(setupTokens)
    .set({ usedAt: at, usedByDeviceId: deviceId })
    .where(
      and(
        eq(setupTokens.tokenHash, hashSetupToken(token)),
        isNull(setupTokens.usedAt),
        isNull(setupTokens.revokedAt),
        gt(setupTokens.expiresAt, at),
      ),
    )
    .returning()
    .get();
  if (row === undefined) return undefined;
  const stored = JSON.parse(row.scopes) as DeviceScope[];
  const scopes = toRecord(row, at).scopes;
  // A row that somehow holds a scope outside the allowed set pairs nobody (and is now spent).
  return scopes.length === stored.length ? { id: row.id, scopes } : undefined;
}

/** Tokens made in the last day, newest first. Never the token. */
export function listSetupTokens(db: PsycheDb, now: string = db.now()): SetupTokenRecord[] {
  const since = new Date(new Date(now).getTime() - 24 * 3_600_000).toISOString();
  return db.drizzle
    .select()
    .from(setupTokens)
    .where(gte(setupTokens.createdAt, since))
    .orderBy(desc(setupTokens.createdAt))
    .all()
    .map((row) => toRecord(row, now));
}

/** Revokes an unused token; a used one keeps its record. Returns the record, or `undefined`. */
export function revokeSetupToken(
  db: PsycheDb,
  id: string,
  now: string = db.now(),
): SetupTokenRecord | undefined {
  const at = new Date(now).toISOString();
  db.drizzle
    .update(setupTokens)
    .set({ revokedAt: at })
    .where(and(eq(setupTokens.id, id), isNull(setupTokens.usedAt), isNull(setupTokens.revokedAt)))
    .run();
  const row = db.drizzle.select().from(setupTokens).where(eq(setupTokens.id, id)).get();
  return row === undefined ? undefined : toRecord(row, at);
}

/**
 * Revokes every unused token a device made. A device that is revoked loses the authority it used
 * to hand out a way in, so a link it made but nobody used yet must stop working with it. Used
 * tokens keep their record. Returns how many were revoked.
 */
export function revokeSetupTokensCreatedBy(
  db: PsycheDb,
  deviceId: string,
  now: string = db.now(),
): number {
  return db.drizzle
    .update(setupTokens)
    .set({ revokedAt: new Date(now).toISOString() })
    .where(
      and(
        eq(setupTokens.createdByDeviceId, deviceId),
        isNull(setupTokens.usedAt),
        isNull(setupTokens.revokedAt),
      ),
    )
    .run().changes;
}
