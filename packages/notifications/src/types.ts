import type { Notification, NotificationKind, Surface } from "@psyche/protocol";

/** Every notification kind, in protocol order. */
export const NOTIFICATION_KINDS = [
  "approval",
  "input_needed",
  "task_done",
  "task_failed",
  "proactive",
  "briefing",
  "reminder",
  "system",
] as const satisfies readonly NotificationKind[];

/**
 * Surface classes (protocol `Surface`): the in-app clients (`desktop`, `web`) get Gateway events,
 * `notification` is the OS through the mac helper, and `device:<deviceId>` is one connected remote
 * desktop client's own OS notifications (remote Gateway design §4.2; the same family as the phone's
 * `push:<deviceId>`). Anything else is `unknown`: chat channels were removed (2026-11-25), so an
 * old `telegram:<peerId>` surface in stored settings or a pending delivery is dropped or
 * suppressed, never sent to the OS or a device.
 */
export type SurfaceClass = "desktop" | "web" | "notification" | "device" | "unknown";

/** Apple's `UNNotificationInterruptionLevel` minus `critical`, which Psyche never uses. */
export type InterruptionLevel = "passive" | "active" | "timeSensitive";

/** Lifecycle of one delivery of one notification to one surface. */
export type DeliveryStatus = "pending" | "deferred" | "delivered" | "failed" | "suppressed";

export interface DeliveryRecord {
  notificationId: string;
  surface: Surface;
  status: DeliveryStatus;
  attempts: number;
  /** When a `pending` retry or a `deferred` (quiet hours) delivery is next due. */
  dueAt: string | null;
  deliveredAt: string | null;
  /** Error message for `failed`, reason for `suppressed`. */
  detail: string | null;
}

/** One inbox row as stored: the wire `Notification` plus routing state. */
export interface StoredNotification {
  notification: Notification;
  dedupeKey: string | null;
  /** Ordering key; bumped when a de-duplicated notify replaces the content. */
  seq: number;
}

/** `os` is the S15 prompt's name for the OS surface; the protocol calls it `notification`. */
const SURFACE_ALIASES: Readonly<Record<string, Surface>> = { os: "notification" };

export function normalizeSurface(surface: Surface): Surface {
  const s = surface.trim();
  return SURFACE_ALIASES[s] ?? s;
}

export function surfaceClass(surface: Surface): SurfaceClass {
  const s = normalizeSurface(surface);
  if (s === "desktop" || s === "web" || s === "notification") return s;
  if (s.startsWith("device:")) return "device";
  return "unknown";
}

/** `device:<deviceId>` to the device id; `undefined` for anything else. */
export function parseDeviceSurface(surface: Surface): string | undefined {
  const s = normalizeSurface(surface);
  if (!s.startsWith("device:") || s.length === "device:".length) return undefined;
  return s.slice("device:".length);
}

/** Surfaces that interrupt the owner (and therefore wait out quiet hours). */
export function isInterruptive(surface: Surface): boolean {
  const c = surfaceClass(surface);
  return c === "notification" || c === "device";
}
