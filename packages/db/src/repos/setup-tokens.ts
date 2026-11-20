import { createHash, randomBytes } from "node:crypto";
import type { DeviceScope, SetupTokenPurpose, SetupTokenScope } from "@psyche/protocol";
import { MACHINE_TOKEN_SCOPES, PsycheError, SETUP_TOKEN_TTL_MS } from "@psyche/protocol";
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

/**
 * What a token is for, derived from the sealed `scopes` column and nothing else: exactly
 * `["node"]` is a `machine` token, operator scopes only is a `device` token, and anything else
 * (a mix, an empty list, an unknown scope) is neither and is refused everywhere. There is no
 * separate purpose column to disagree with the scopes.
 */
export function setupTokenPurposeOf(scopes: readonly string[]): SetupTokenPurpose | undefined {
  if (scopes.length === 1 && scopes[0] === MACHINE_TOKEN_SCOPES[0]) return "machine";
  if (
    scopes.length > 0 &&
    scopes.every((s) => (SETUP_TOKEN_SCOPES as readonly string[]).includes(s))
  ) {
    return "device";
  }
  return undefined;
}

export interface SetupTokenRecord {
  id: string;
  /** Operator scopes for a `device` token; exactly `["node"]` for a `machine` token. */
  scopes: DeviceScope[];
  purpose: SetupTokenPurpose;
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
  const stored = JSON.parse(row.scopes) as DeviceScope[];
  const purpose = setupTokenPurposeOf(stored) ?? "device";
  // A row that is neither shows no scopes at all (and `consumeSetupToken` refuses it).
  const scopes = setupTokenPurposeOf(stored) === undefined ? [] : stored;
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
    purpose,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    usedByDeviceId: row.usedByDeviceId,
    revokedAt: row.revokedAt,
    status,
  };
}

/**
 * Makes a token. Returns the token (the only time it exists in the clear) and its record. A
 * `device` token (the default) refuses the scope `node` and an empty list. A `machine` token takes
 * no scopes of its own and is always exactly `["node"]`. Both refuse a live token beyond
 * `MAX_LIVE_SETUP_TOKENS`.
 */
export function createSetupToken(
  db: PsycheDb,
  input: {
    scopes?: readonly DeviceScope[];
    /** Default `device`. */
    purpose?: SetupTokenPurpose;
    createdByDeviceId?: string | null;
    ttlMs?: number;
    /** The LAN certificate pin the token's link carries (a v2 link). */
    certPin?: string | null;
  },
): { token: string; record: SetupTokenRecord } {
  let scopes: DeviceScope[];
  if (input.purpose === "machine") {
    if (input.scopes !== undefined && input.scopes.length > 0) {
      throw new PsycheError("invalid_params", "A machine setup token takes no scopes");
    }
    scopes = [...MACHINE_TOKEN_SCOPES];
  } else {
    const requested = [...new Set(input.scopes ?? [])];
    scopes = requested.filter(isTokenScope);
    if (scopes.length === 0 || scopes.length !== requested.length) {
      throw new PsycheError("invalid_params", "A setup token grants operator scopes only");
    }
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
          certPin: input.certPin ?? null,
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
 *
 * `purpose` is what the presenting connection is: a `device` token is spent only by a client, a
 * `machine` token only by a node, and the check is part of the same UPDATE, so a token presented
 * for the wrong purpose is refused and stays unspent. `any` spends a token whatever it is for
 * (a device that is already paired burns the link it presented, and gets nothing from it).
 */
export function consumeSetupToken(
  db: PsycheDb,
  token: string,
  deviceId: string,
  now: string = db.now(),
  purpose: SetupTokenPurpose | "any" = "device",
):
  | {
      id: string;
      scopes: DeviceScope[];
      purpose: SetupTokenPurpose;
      createdByDeviceId: string | null;
    }
  | undefined {
  const at = new Date(now).toISOString();
  const machineScopes = JSON.stringify([...MACHINE_TOKEN_SCOPES]);
  // `node` anywhere in the scopes makes a token a machine token; a device token has none.
  const purposeMatches =
    purpose === "any"
      ? sql`1 = 1`
      : purpose === "machine"
        ? sql`${setupTokens.scopes} = ${machineScopes}`
        : sql`NOT EXISTS (SELECT 1 FROM json_each(${setupTokens.scopes}) WHERE value = 'node')`;
  const row = db.drizzle
    .update(setupTokens)
    .set({ usedAt: at, usedByDeviceId: deviceId })
    .where(
      and(
        eq(setupTokens.tokenHash, hashSetupToken(token)),
        isNull(setupTokens.usedAt),
        isNull(setupTokens.revokedAt),
        gt(setupTokens.expiresAt, at),
        purposeMatches,
      ),
    )
    .returning()
    .get();
  if (row === undefined) return undefined;
  const stored = JSON.parse(row.scopes) as DeviceScope[];
  const found = setupTokenPurposeOf(stored);
  // A row that is neither kind of token pairs nobody (and is now spent).
  return found === undefined
    ? undefined
    : { id: row.id, scopes: stored, purpose: found, createdByDeviceId: row.createdByDeviceId };
}

/**
 * Whether `token` could be spent now: it exists, is unused, unrevoked and unexpired. A cheap
 * lookup by hash that changes nothing (spending is `consumeSetupToken`'s one UPDATE).
 */
export function peekSetupToken(db: PsycheDb, token: string, now: string = db.now()): boolean {
  const at = new Date(now).toISOString();
  return (
    db.drizzle
      .select({ id: setupTokens.id })
      .from(setupTokens)
      .where(
        and(
          eq(setupTokens.tokenHash, hashSetupToken(token)),
          isNull(setupTokens.usedAt),
          isNull(setupTokens.revokedAt),
          gt(setupTokens.expiresAt, at),
        ),
      )
      .get() !== undefined
  );
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
 * Revokes every unused token whose link carries a LAN certificate pin (a v2 link). Used when the
 * LAN certificate is replaced: those links belong to the old certificate. Returns how many.
 */
export function revokeSetupTokensWithCertPin(db: PsycheDb, now: string = db.now()): number {
  return db.drizzle
    .update(setupTokens)
    .set({ revokedAt: new Date(now).toISOString() })
    .where(
      and(
        sql`${setupTokens.certPin} IS NOT NULL`,
        isNull(setupTokens.usedAt),
        isNull(setupTokens.revokedAt),
      ),
    )
    .run().changes;
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
