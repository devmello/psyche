import { getSetting, type PsycheDb, setSetting } from "@psyche/db";

/** Setting keys starting with this prefix are Gateway-internal and never exposed. */
export const INTERNAL_SETTING_PREFIX = "_";
export const STATE_VERSION_KEY = "_gateway.stateVersion";

export function readStateVersion(db: PsycheDb): number {
  const value = getSetting(db, STATE_VERSION_KEY)?.value;
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

export function writeStateVersion(db: PsycheDb, v: number): void {
  setSetting(db, STATE_VERSION_KEY, v);
}
