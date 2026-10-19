import type { Notification as PsycheNotification } from "@psyche/protocol";
import { isAppRoute } from "./deep-link.ts";

/**
 * Desktop notification relay (feature O10, docs/06 §3.20). OS notifications with actions and
 * interruption levels come from the mac helper (it is a node and the Gateway routes to it). The
 * desktop falls back to Electron's `Notification` only when no helper is online, and its fallback
 * never carries Approve buttons: approving needs the full card (and Touch ID for purchases and
 * fills), so a click opens the card instead.
 */

export interface RelayDecision {
  show: boolean;
  reason?: "not_os_surface" | "helper_delivers" | "already_handled" | "duplicate";
  title?: string;
  body?: string;
  /** App route opened on click; falls back to the inbox. */
  route?: string;
  /** macOS interruption level hint for the fallback. */
  urgency?: "normal" | "critical" | "low";
}

const URGENT = new Set(["approval", "input_needed"]);
const PASSIVE = new Set(["proactive", "briefing"]);

export class NotificationRelay {
  private readonly seen = new Set<string>();
  helperOnline = false;

  decide(n: PsycheNotification): RelayDecision {
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
