import type { Tool } from "@modelcontextprotocol/client";
import type { McpTrustTier, ProvenanceOut, SideEffect } from "@psyche/protocol";

/**
 * Side-effect class of an MCP tool (security §11: "annotations are untrusted hints, actionable
 * only for `bundled`"). For `bundled` servers the hints are taken at face value. For `verified`
 * and `unknown` servers a hint may only raise severity: `readOnlyHint` never lowers a tool below
 * `write`, while `destructiveHint` still raises it to `destructive`.
 */
export function sideEffectFor(tool: Pick<Tool, "annotations">, trust: McpTrustTier): SideEffect {
  const a = tool.annotations ?? {};
  // Spec defaults: destructiveHint true when readOnlyHint is false/absent.
  const readOnly = a.readOnlyHint === true;
  const destructive = !readOnly && a.destructiveHint === true;
  if (trust === "bundled") {
    if (readOnly) return "read";
    return destructive ? "destructive" : "write";
  }
  return destructive ? "destructive" : "write";
}

/** Results from anything but a bundled server are data, never instructions (security §7.2). */
export function provenanceFor(trust: McpTrustTier): ProvenanceOut {
  return trust === "bundled" ? "trusted" : "untrusted";
}

/**
 * Tools whose server-declared `_meta` asks for a prompt on every call (Claude Code's
 * `anthropic/requiresUserInteraction`). The host reports it so the broker can refuse standing
 * grants; it is a hint that only ever makes policy stricter.
 */
export function requiresUserInteraction(tool: Pick<Tool, "_meta">): boolean {
  return (
    (tool._meta as Record<string, unknown> | undefined)?.["anthropic/requiresUserInteraction"] ===
    true
  );
}
