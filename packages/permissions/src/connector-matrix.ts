import type { ApprovalKind, SideEffect } from "@psyche/protocol";
import { AUTH_KINDS, DEVICE_ONLY_KINDS, SEVERITY } from "./kinds.ts";

/**
 * The owner's connector action matrix (security §3.11 `permissions.connectors`; Settings →
 * Connectors, #747). Keys are a connector's action groups (`mail.organize`), or a narrower
 * `<group>/<sub-key>` a connector names per call (`shortcuts.run/<shortcutId>`, from the owner's
 * per-shortcut setting): the owner's sub-key entry overrides the group's, except that a group
 * `deny` always wins (the same order as the connector executor, #727). Only the Gateway writes
 * sub-key entries, from the owner's own settings; the hard floors still apply unless the owner
 * lifted one (`floorLifted`).
 */
export type MatrixRule = "allow" | "ask" | "deny";

const isRule = (v: unknown): v is MatrixRule => v === "allow" || v === "ask" || v === "deny";

/** The owner's entry for `action` in one connector's matrix, or undefined when there is none. */
export function matrixRule(
  matrix: Readonly<Record<string, unknown>> | undefined,
  action: string,
): MatrixRule | undefined {
  if (matrix === undefined) return undefined;
  const own = matrix[action];
  const slash = action.indexOf("/");
  if (slash <= 0) return isRule(own) ? own : undefined;
  const group = matrix[action.slice(0, slash)];
  if (group === "deny") return "deny";
  if (isRule(own)) return own;
  return isRule(group) ? group : undefined;
}

/** Kinds that put a message in someone else's hands: an owner `allow` never makes them silent. */
export const SEND_KINDS: readonly ApprovalKind[] = ["send_email", "message_send"];

/** The floor class of a call: sends, destructive and financial calls ask by default (§3.12). */
export type FloorClass = "send" | "destructive" | "financial";

/**
 * Which liftable floor a call falls under, or undefined. Device-only and authentication kinds
 * (credential entry, vault fills, purchases, pairing, …) are never liftable, whatever their class.
 */
export function floorClass(kind: ApprovalKind, sideEffect: SideEffect): FloorClass | undefined {
  if (DEVICE_ONLY_KINDS.includes(kind) || AUTH_KINDS.includes(kind)) return undefined;
  if (SEND_KINDS.includes(kind)) return "send";
  if (sideEffect === "financial") return "financial";
  if (sideEffect === "destructive") return "destructive";
  return undefined;
}

/**
 * Whether the owner lifted the floor for `action` in one connector (`permissions.liftedFloors`,
 * set only by Settings' confirmed opt-in). A `<group>/<sub-key>` action is covered by its group.
 */
export function floorLifted(lifted: readonly string[] | undefined, action: string): boolean {
  if (lifted === undefined) return false;
  if (lifted.includes(action)) return true;
  const slash = action.indexOf("/");
  return slash > 0 && lifted.includes(action.slice(0, slash));
}

/**
 * Why an owner `allow` cannot lift the card for this call (the hard floors), or undefined. Sends,
 * destructive and financial calls ask unless the owner lifted the floor for this action (`lifted`,
 * the confirmed override; a plain `allow` never does); device-only and authentication kinds keep
 * their cards with no override (security §3.7, §3.12, §9).
 */
export function matrixFloor(
  kind: ApprovalKind,
  sideEffect: SideEffect,
  lifted = false,
): string | undefined {
  if (lifted && floorClass(kind, sideEffect) !== undefined) return undefined;
  if (SEND_KINDS.includes(kind)) return "sends always ask";
  if (SEVERITY[sideEffect] >= SEVERITY.destructive) return `${sideEffect} actions always ask`;
  if (DEVICE_ONLY_KINDS.includes(kind) || AUTH_KINDS.includes(kind))
    return `${kind} approvals always ask`;
  return undefined;
}
