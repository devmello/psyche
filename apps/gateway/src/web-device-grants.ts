import { legacyWebDeviceIds, type PsycheDb } from "@psyche/db";

/**
 * Browser access was dropped (owner, 2026-11-25) and migration `db_drop-web-devices` revoked every
 * `platform = 'web'` device. It could not end the standing grants those browsers approved: a grant
 * row is sealed, so a SQL update would invalidate its seal. This sweep goes through the broker's
 * own revoke path (`revokeGrantsByDevice`, which re-seals the row and writes the audit entry) at
 * startup. It is idempotent: only grants still active are touched, so a second boot finds none.
 *
 * Returns the number of grants it revoked.
 */
export async function revokeWebDeviceGrants(
  db: PsycheDb,
  broker: { revokeGrantsByDevice(deviceId: string): Promise<unknown[]> },
): Promise<number> {
  let n = 0;
  for (const id of legacyWebDeviceIds(db)) {
    n += (await broker.revokeGrantsByDevice(id)).length;
  }
  return n;
}
