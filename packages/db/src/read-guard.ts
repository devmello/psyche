import type { PsycheDb } from "./open.ts";

/**
 * A hook the Gateway's security-state seal installs on its connection
 * (docs/design/security-state-integrity-2026.md §7.1). Reads that can authorize something
 * (settings, devices) call `check()` first, so a change another process made is found and undone
 * before it is read; while the seal is untrusted, `setting()` may answer with the value the
 * Gateway last knew to be genuine instead of what the file holds. A connection without a guard
 * reads as before.
 */
export interface ReadGuard {
  check(): void;
  /**
   * The stored (JSON-encoded) value to use for `key`, given what the row holds (`undefined`
   * when there is no row). Return `undefined` for "no such setting".
   */
  setting?(key: string, stored: string | undefined): string | undefined;
}

const GUARDS = new WeakMap<object, ReadGuard>();

export function setReadGuard(db: PsycheDb, guard: ReadGuard | undefined): void {
  if (guard === undefined) GUARDS.delete(db.sqlite);
  else GUARDS.set(db.sqlite, guard);
}

export function readGuardOf(db: PsycheDb): ReadGuard | undefined {
  return GUARDS.get(db.sqlite);
}
