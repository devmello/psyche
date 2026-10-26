import type { ApprovalKind, SideEffect } from "@psyche/protocol";
import { AUTH_KINDS, DEVICE_ONLY_KINDS, SEVERITY } from "./kinds.ts";

/**
 * The owner's connector action matrix (security §3.11 `permissions.connectors`; Settings →
 * Connectors, #747). Keys are a connector's action groups (`mail.organize`), or a narrower
 * `<group>/<sub-key>` a connector names per call (`shortcuts.run/<shortcutId>`): the stricter of
 * the sub-key's and the group's entry applies, so a sub-key can never loosen its group.
 */
export type MatrixRule = "allow" | "ask" | "deny";

const STRICTNESS: Record<MatrixRule, number> = { allow: 0, ask: 1, deny: 2 };

const isRule = (v: unknown): v is MatrixRule => v === "allow" || v === "ask" || v === "deny";

/** The owner's entry for `action` in one connector's matrix, or undefined when there is none. */
export function matrixRule(
  matrix: Readonly<Record<string, unknown>> | undefined,
  action: string,
): MatrixRule | undefined {
  if (matrix === undefined) return undefined;
  const slash = action.indexOf("/");
  const rules = [matrix[action], slash > 0 ? matrix[action.slice(0, slash)] : undefined].filter(
    isRule,
  );
  if (rules.length === 0) return undefined;
  return rules.reduce((a, b) => (STRICTNESS[b] > STRICTNESS[a] ? b : a));
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
