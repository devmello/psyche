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
 * `notification` is the OS through the mac helper, `<channel>:<peerId>` is a chat channel.
 */
export type SurfaceClass = "desktop" | "web" | "notification" | "channel";

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
  return "channel";
}

/** Splits `<channel>:<peerId>`; `undefined` for anything that is not a channel surface. */
export function parseChannelSurface(
  surface: Surface,
): { channel: string; peerId: string } | undefined {
  const s = normalizeSurface(surface);
  const i = s.indexOf(":");
  if (i <= 0 || i === s.length - 1 || surfaceClass(s) !== "channel") return undefined;
  return { channel: s.slice(0, i), peerId: s.slice(i + 1) };
}

/** Surfaces that interrupt the owner (and therefore wait out quiet hours). */
export function isInterruptive(surface: Surface): boolean {
  const c = surfaceClass(surface);
  return c === "notification" || c === "channel";
}
