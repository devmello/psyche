import type { NotificationKind, Surface } from "@psyche/protocol";
import { breaksThrough, isQuietAt, type QuietHoursConfig, quietEndsAt } from "./quiet-hours.ts";
import { type InterruptionLevel, isInterruptive, normalizeSurface, surfaceClass } from "./types.ts";

/**
 * Routing policy (architecture §4.12, UI §3.20). Callers may pass explicit `surfaces`; otherwise
 * the kind's defaults apply, plus the owner's channel targets for the kinds that go to chat.
 */
export interface RoutingConfig {
  /** Default surfaces per kind; merged over `DEFAULT_SURFACES`. */
  surfaces?: Partial<Record<NotificationKind, Surface[]>>;
  /** The owner's chat surfaces (`telegram:12345`), added for `channelKinds`. */
  channelTargets?: Surface[];
  /** Kinds that also go to `channelTargets` when no explicit surfaces are given. */
  channelKinds?: NotificationKind[];
  /** OS interruption level per kind; merged over `DEFAULT_INTERRUPTION`. */
  interruption?: Partial<Record<NotificationKind, InterruptionLevel>>;
  quietHours?: QuietHoursConfig | null;
}

/**
 * The in-app inbox (`desktop`, `web`) always gets the row. The OS gets everything that needs the
 * owner or reports a finished task; proactive output and briefings stay in the app (calm by
 * default, UI §2 principle 2; ADR-012), and the owner can opt them into the OS in settings.
 */
export const DEFAULT_SURFACES: Readonly<Record<NotificationKind, readonly Surface[]>> = {
  approval: ["desktop", "web", "notification"],
  input_needed: ["desktop", "web", "notification"],
  task_done: ["desktop", "web", "notification"],
  task_failed: ["desktop", "web", "notification"],
  proactive: ["desktop", "web"],
  briefing: ["desktop", "web"],
  reminder: ["desktop", "web", "notification"],
  system: ["desktop", "web"],
  // A specialist's one result card (docs/agent/specialists-2026.md §6.2): like a finished task.
  specialist_result: ["desktop", "web", "notification"],
};

export const DEFAULT_CHANNEL_KINDS: readonly NotificationKind[] = [
  "approval",
  "input_needed",
  "task_done",
  "task_failed",
  "reminder",
  "specialist_result",
];

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
};

export function resolveSurfaces(
  config: RoutingConfig,
  kind: NotificationKind,
  explicit?: readonly Surface[],
): Surface[] {
  let list: readonly Surface[];
  if (explicit !== undefined && explicit.length > 0) {
    list = explicit;
  } else {
    const base = config.surfaces?.[kind] ?? DEFAULT_SURFACES[kind];
    const toChat = (config.channelKinds ?? DEFAULT_CHANNEL_KINDS).includes(kind);
    list = toChat ? [...base, ...(config.channelTargets ?? [])] : base;
  }
  const out: Surface[] = [];
  for (const s of list) {
    const n = normalizeSurface(s);
    if (n.length > 0 && !out.includes(n)) out.push(n);
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
    if (c === "desktop" || c === "web") return { surface, action: "in_app" };
    if (quiet && isInterruptive(surface)) {
      // An every-day window never ends; park the delivery a day out and re-check then.
      return { surface, action: "defer", until: until ?? now + 24 * 60 * 60_000 };
    }
    return { surface, action: "now" };
  });
}
