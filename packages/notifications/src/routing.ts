import type { NotificationKind, Surface } from "@psyche/protocol";
import { breaksThrough, isQuietAt, type QuietHoursConfig, quietEndsAt } from "./quiet-hours.ts";
import { type InterruptionLevel, isInterruptive, normalizeSurface, surfaceClass } from "./types.ts";

/**
 * Routing policy (architecture §4.12, UI §3.20). Callers may pass explicit `surfaces`; otherwise
 * the kind's defaults apply. Surfaces of an unknown class (an old chat channel's `telegram:1`) are
 * dropped: they have no adapter and must never fall through to the OS or a device.
 */
export interface RoutingConfig {
  /** Default surfaces per kind; merged over `DEFAULT_SURFACES`. */
  surfaces?: Partial<Record<NotificationKind, Surface[]>>;
  /** OS interruption level per kind; merged over `DEFAULT_INTERRUPTION`. */
  interruption?: Partial<Record<NotificationKind, InterruptionLevel>>;
  quietHours?: QuietHoursConfig | null;
  /**
   * `device:<deviceId>` surfaces of the remote desktop clients connected right now. Added next to
   * `notification` (whatever puts a notification on the OS also puts it on those clients' OS).
   */
  deviceTargets?: Surface[];
}

/**
 * The in-app inbox (`desktop`, `offMac`) always gets the row. The OS gets everything that needs the
 * owner or reports a finished task; proactive output and briefings stay in the app (calm by
 * default, UI §2 principle 2; ADR-012), and the owner can opt them into the OS in settings.
 */
export const DEFAULT_SURFACES: Readonly<Record<NotificationKind, readonly Surface[]>> = {
  approval: ["desktop", "offMac", "notification"],
  input_needed: ["desktop", "offMac", "notification"],
  task_done: ["desktop", "offMac", "notification"],
  task_failed: ["desktop", "offMac", "notification"],
  proactive: ["desktop", "offMac"],
  briefing: ["desktop", "offMac"],
  reminder: ["desktop", "offMac", "notification"],
  system: ["desktop", "offMac"],
  // A specialist's one result card (docs/agent/specialists-2026.md §6.2): like a finished task.
  specialist_result: ["desktop", "offMac", "notification"],
  // A warning before the owner breaks their own promise (docs/design/promise-ledger-2026.md
  // §5.1). The OS gets it.
  promise_due: ["desktop", "offMac", "notification"],
};

/** UI §3.20: approvals are time-sensitive; proactive, briefing and reminder are passive. */
export const DEFAULT_INTERRUPTION: Readonly<Record<NotificationKind, InterruptionLevel>> = {
  approval: "timeSensitive",
  input_needed: "active",
  task_done: "active",
  task_failed: "active",
  proactive: "passive",
  briefing: "passive",
  reminder: "passive",
  system: "passive",
  specialist_result: "active",
  promise_due: "active",
};

export function resolveSurfaces(
  config: RoutingConfig,
  kind: NotificationKind,
  explicit?: readonly Surface[],
): Surface[] {
  let list: readonly Surface[] =
    explicit !== undefined && explicit.length > 0
      ? explicit
      : (config.surfaces?.[kind] ?? DEFAULT_SURFACES[kind]);
  const onOs = list.some((s) => normalizeSurface(s) === "notification");
  if (onOs && config.deviceTargets !== undefined) list = [...list, ...config.deviceTargets];
  const out: Surface[] = [];
  for (const s of list) {
    const n = normalizeSurface(s);
    if (n.length > 0 && surfaceClass(n) !== "unknown" && !out.includes(n)) out.push(n);
  }
  return out;
}

export function interruptionFor(config: RoutingConfig, kind: NotificationKind): InterruptionLevel {
  return config.interruption?.[kind] ?? DEFAULT_INTERRUPTION[kind];
}

export type DeliveryPlan =
  | { surface: Surface; action: "now" }
  | { surface: Surface; action: "defer"; until: number }
  /** In-app surfaces are delivered by the Notifier's own events, not by an adapter. */
  | { surface: Surface; action: "in_app" };

/** Decides, per surface, whether to deliver now, defer past quiet hours, or rely on events. */
export function planDelivery(
  config: RoutingConfig,
  kind: NotificationKind,
  surfaces: readonly Surface[],
  now: number,
  options: { breakQuietHours?: boolean } = {},
): DeliveryPlan[] {
  const qh = config.quietHours ?? null;
  // A kind whose OS interruption level is time-sensitive (approvals) always comes through.
  const quiet =
    qh !== null &&
    options.breakQuietHours !== true &&
    interruptionFor(config, kind) !== "timeSensitive" &&
    !breaksThrough(qh, kind) &&
    isQuietAt(qh, now);
  const until = quiet ? quietEndsAt(qh, now) : undefined;
  return surfaces.map((surface): DeliveryPlan => {
    const c = surfaceClass(surface);
    if (c === "desktop" || c === "offMac") return { surface, action: "in_app" };
    if (quiet && isInterruptive(surface)) {
      // An every-day window never ends; park the delivery a day out and re-check then.
      return { surface, action: "defer", until: until ?? now + 24 * 60 * 60_000 };
    }
    return { surface, action: "now" };
  });
}
