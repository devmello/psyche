import type { McpServerTool } from "@psyche/protocol";
import type { McpServerDetails } from "./host.ts";
import type { ToolWarning } from "./inspect.ts";

/** Warnings that keep a non-bundled server's tool from the agent (security §11, #281). */
export const BLOCKING_WARNINGS: ReadonlySet<ToolWarning["code"]> = new Set([
  "instruction_like",
  "hidden_markup",
  "invisible_characters",
]);

/** A tool the description scan keeps from the agent. */
export function isBlocked(tool: string, warnings: readonly ToolWarning[]): boolean {
  return warnings.some((w) => w.tool === tool && BLOCKING_WARNINGS.has(w.code));
}

/** `readOnlyHint` / `destructiveHint` when the server gave annotations; absent otherwise. */
function annotatedSideEffect(annotations: unknown): McpServerTool["sideEffect"] {
  const a = (annotations ?? {}) as { readOnlyHint?: unknown; destructiveHint?: unknown };
  if (a.readOnlyHint === true) return "read";
  if (a.destructiveHint === true) return "destructive";
  if (a.readOnlyHint === false || a.destructiveHint === false) return "write";
  return undefined;
}

/**
 * A connected server's tools as Settings lists them: the server's own words (cut to 2,000
 * characters, still untrusted), its annotation as a hint, and whether the agent is offered each
 * one (not switched off by the owner, not blocked by the description scan).
 */
export function serverTools(
  details: Pick<McpServerDetails, "tools" | "warnings">,
  disabled: readonly string[],
): McpServerTool[] {
  const off = new Set(disabled);
  return details.tools.map((t) => {
    const sideEffect = annotatedSideEffect(t.annotations);
    return {
      name: t.name,
      description: (t.description ?? "").slice(0, 2_000),
      ...(sideEffect === undefined ? {} : { sideEffect }),
      enabled: !off.has(t.name),
      blocked: isBlocked(t.name, details.warnings),
    };
  });
}
