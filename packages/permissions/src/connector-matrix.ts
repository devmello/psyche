import type { ApprovalKind, SideEffect } from "@psyche/protocol";
import { AUTH_KINDS, DEVICE_ONLY_KINDS, SEVERITY } from "./kinds.ts";

/**
 * The owner's connector action matrix (security §3.11 `permissions.connectors`; Settings →
 * Connectors, #747). Keys are a connector's action groups (`mail.organize`), or a narrower
 * `<group>/<sub-key>` a connector names per call (`shortcuts.run/<shortcutId>`, from the owner's
 * per-shortcut setting): the owner's sub-key entry overrides the group's, except that a group
 * `deny` always wins (the same order as the connector executor, #727). Only the Gateway writes
 * sub-key entries, from the owner's own settings; the hard floors still apply.
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
const SEND_KINDS: readonly ApprovalKind[] = ["send_email", "message_send"];

/**
 * Why an owner `allow` cannot lift the card for this call (the hard floors), or undefined. Sends,
 * destructive and financial calls always ask; device-only and authentication kinds keep their
 * cards (security §3.7, §9).
 */
export function matrixFloor(kind: ApprovalKind, sideEffect: SideEffect): string | undefined {
  if (SEND_KINDS.includes(kind)) return "sends always ask";
  if (SEVERITY[sideEffect] >= SEVERITY.destructive) return `${sideEffect} actions always ask`;
  if (DEVICE_ONLY_KINDS.includes(kind) || AUTH_KINDS.includes(kind))
    return `${kind} approvals always ask`;
  return undefined;
}
