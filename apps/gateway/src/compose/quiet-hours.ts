import { getSetting, type PsycheDb } from "@psyche/db";
import {
  isQuietAt,
  type QuietHoursConfig,
  quietHoursFromSettings,
  type RoutingConfig,
} from "@psyche/notifications";

/**
 * Settings → Notifications → Quiet hours (#953) as the Gateway applies them. Both consumers read
 * the settings on every evaluation, so a change takes effect on the next notification without a
 * restart: `PsycheNotifier` takes `notifierRouting(db)` as its routing getter, and the meeting
 * prep service asks `isQuietAt` for the meeting's start. The zone is the system's, read each time
 * so a Mac that travels follows its clock.
 */

export const systemTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The owner's window right now, or `null` while quiet hours are off (the default). */
export function ownerQuietHours(
  db: PsycheDb,
  zone: () => string = systemTimeZone,
): QuietHoursConfig | null {
  return quietHoursFromSettings((key) => getSetting(db, key)?.value, zone());
}

/** The notifier's routing getter: everything default, plus the owner's quiet hours. */
export function notifierRouting(
  db: PsycheDb,
  zone: () => string = systemTimeZone,
): () => RoutingConfig {
  return () => ({ quietHours: ownerQuietHours(db, zone) });
}

/** `true` when `ms` falls inside the owner's quiet hours (the meeting prep service's `isQuiet`). */
export function isOwnerQuietAt(
  db: PsycheDb,
  ms: number,
  zone: () => string = systemTimeZone,
): boolean {
  const qh = ownerQuietHours(db, zone);
  return qh !== null && isQuietAt(qh, ms);
}
