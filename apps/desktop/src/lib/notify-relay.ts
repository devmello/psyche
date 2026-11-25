import type { Notification as PsycheNotification } from "@psyche/protocol";
import { isAppRoute } from "./deep-link.ts";

/**
 * Desktop notification relay (feature O10, docs/06 §3.20). OS notifications with actions and
 * interruption levels come from the mac helper (it is a node and the Gateway routes to it). The
 * desktop falls back to Electron's `Notification` only when no helper is online, and its fallback
 * never carries Approve buttons: approving needs the full card (and Touch ID for purchases and
 * fills), so a click opens the card instead.
 */

/**
 * A `notification.device` event (the Host's `device:<deviceId>` surface, remote Gateway R2): what a
 * client of another computer's Gateway shows through its own OS. It has no actions on purpose.
 */
export interface DeviceToast {
  id: string;
  kind: PsycheNotification["kind"];
  title: string;
  body: string;
  route: string | null;
  interruption: "passive" | "active" | "timeSensitive";
}

export interface RelayDecision {
  show: boolean;
  reason?:
    | "not_os_surface"
    | "helper_delivers"
    | "already_handled"
    | "duplicate"
    | "host_routes"
    | "malformed";
  title?: string;
  body?: string;
  /** App route opened on click; falls back to the inbox. */
  route?: string;
  /** macOS interruption level hint for the fallback. */
  urgency?: "normal" | "critical" | "low";
}

const URGENT = new Set(["approval", "input_needed"]);
const PASSIVE = new Set(["proactive", "briefing"]);

/** How long a notification waits for the first helper presence check (about 2 s). */
export const PRESENCE_HOLD_MS = 2_000;

export class NotificationRelay {
  private readonly seen = new Set<string>();
  helperOnline = false;
  /** False until the first presence check lands. Until then a toast could double the helper's. */
  presenceKnown = false;
  private held: { n: PsycheNotification; show: (d: RelayDecision) => void }[] = [];
  private holdTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Decides a notification now, or holds it until the first presence check lands, or
   * `PRESENCE_HOLD_MS` passes, whichever comes first. The decision is the same either way.
   */
  offer(n: PsycheNotification, show: (d: RelayDecision) => void): void {
    if (this.presenceKnown) {
      show(this.decide(n));
      return;
    }
    this.held.push({ n, show });
    this.holdTimer ??= setTimeout(() => this.flush(), PRESENCE_HOLD_MS);
  }

  /** The first (or a later) helper presence check: records it and decides what was held. */
  setPresence(helperOnline: boolean): void {
    this.helperOnline = helperOnline;
    this.presenceKnown = true;
    this.flush();
  }

  private flush(): void {
    if (this.holdTimer !== undefined) clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    const held = this.held;
    this.held = [];
    for (const h of held) h.show(this.decide(h.n));
  }
  /**
   * A client of another computer's Gateway: the Host routes OS notifications to it as
   * `notification.device` events (quiet hours and interruption levels applied there), so the
   * fallback off `notification.created` stays quiet. Otherwise a toast would show twice, and a
   * passive one would show through the Host's quiet hours.
   */
  remote = false;

  /** One OS notification from the Host's `device:<deviceId>` surface; a click opens its route. */
  decideDevice(t: unknown): RelayDecision {
    const x = t as Partial<DeviceToast> | null;
    if (
      typeof x?.id !== "string" ||
      typeof x.title !== "string" ||
      typeof x.body !== "string" ||
      x.id.length === 0
    )
      return { show: false, reason: "malformed" };
    if (this.seen.has(x.id)) return { show: false, reason: "duplicate" };
    this.seen.add(x.id);
    if (this.seen.size > 2_000) this.seen.delete(this.seen.values().next().value as string);
    const route =
      typeof x.route === "string" && isAppRoute(x.route)
        ? x.route
        : x.kind === "approval"
          ? "/agent/approvals"
          : "/inbox";
    return {
      show: true,
      title: x.title.slice(0, 120),
      body: x.body.slice(0, 400),
      route,
      urgency:
        x.interruption === "timeSensitive"
          ? "critical"
          : x.interruption === "passive"
            ? "low"
            : "normal",
    };
  }

  decide(n: PsycheNotification): RelayDecision {
    if (this.remote) return { show: false, reason: "host_routes" };
    if (!n.surfaces.includes("notification")) return { show: false, reason: "not_os_surface" };
    if (n.readAt !== null || n.resolvedAt !== null || n.delivered.notification !== undefined)
      return { show: false, reason: "already_handled" };
    if (this.helperOnline) return { show: false, reason: "helper_delivers" };
    // One OS notification per notification id (the Gateway dedupes per task state change).
    if (this.seen.has(n.id)) return { show: false, reason: "duplicate" };
    this.seen.add(n.id);
    if (this.seen.size > 2_000) this.seen.delete(this.seen.values().next().value as string);
    const route =
      n.route && isAppRoute(n.route) ? n.route : n.approvalId ? "/agent/approvals" : "/inbox";
    return {
      show: true,
      title: n.title.slice(0, 120),
      body: n.body.slice(0, 400),
      route,
      urgency: URGENT.has(n.kind) ? "critical" : PASSIVE.has(n.kind) ? "low" : "normal",
    };
  }
}
