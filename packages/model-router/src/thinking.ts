import { createHash } from "node:crypto";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { ModelRequest } from "@psyche/protocol";
import type { ToolNameMap } from "./tool-names.ts";

/**
 * Anthropic binds a signed thinking block to the request prefix it was produced under (the
 * system prompt and the tool list). Replaying the block after the prefix changed (a tool
 * withheld in plan mode or an unattended run, a connector added, a new system prompt) fails
 * with `Invalid signature in thinking block … bound to a different conversation` (#306).
 *
 * The adapter stamps each Anthropic thinking envelope with a fingerprint of that prefix, and
 * the request converter drops envelopes whose fingerprint no longer matches. Envelopes stored
 * before the fingerprint existed, and the thinking of a tool loop still in flight, are left to
 * the API's own `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`.
 */

/** Beta that enables `thinking.block_binding` on the Messages API. */
export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

const ON_TYPES = new Set(["adaptive", "enabled", "between_tools"]);

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Fingerprint of what a thinking block is bound to: system prompt and provider-facing tools. */
export function thinkingPrefix(request: ModelRequest, names: ToolNameMap): string {
  const tools = (request.tools ?? []).map((t) => [
    names.toProvider(t.name),
    t.description,
    t.inputSchema,
  ]);
  const canonical = JSON.stringify(stable({ system: request.system ?? "", tools }));
  return `sha256:${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

/** Whether the merged provider options turn thinking on for this call. */
export function thinkingOn(options: SharedV4ProviderOptions, key: string): boolean {
  const thinking = (options[key] as { thinking?: { type?: unknown } } | undefined)?.thinking;
  return typeof thinking?.type === "string" && ON_TYPES.has(thinking.type);
}
