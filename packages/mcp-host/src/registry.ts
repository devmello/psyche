import type { McpHost, ToolRegistry, Unsubscribe } from "@psyche/protocol";
import { mcpToolName, parseMcpToolName } from "./naming.ts";

/**
 * Registers a server's tools into the agent-core registry as `mcp__<server>__<tool>`. Each
 * executor carries the `tools/list` hash the registration saw, so after a change every call
 * fails with `conflict` until `sync()` re-registers the new listing (whose standing grants are
 * new keys: the owner is asked again).
 */
export interface McpRegistration {
  /** Re-list and re-register; returns the hash now registered. */
  sync(): Promise<string>;
  unregister(): void;
}

/** A host that can name a server's raw tools (`PsycheMcpHost.describe`). */
interface Describable {
  describe(serverId: string): { tools: { name: string }[] };
}

function hasDescribe(host: McpHost): host is McpHost & Describable {
  return typeof (host as Partial<Describable>).describe === "function";
}

export async function registerMcpServerTools(
  host: McpHost,
  registry: ToolRegistry,
  serverId: string,
): Promise<McpRegistration> {
  let unsubs: Unsubscribe[] = [];
  const unregister = () => {
    for (const u of unsubs) u();
    unsubs = [];
  };
  const sync = async () => {
    const { tools, toolsListHash } = await host.listTools(serverId);
    // Registry names are sanitized; map them back to the server's own tool names.
    const raw = new Map<string, string>();
    if (hasDescribe(host)) {
      for (const t of host.describe(serverId).tools) raw.set(mcpToolName(serverId, t.name), t.name);
    }
    unregister();
    for (const spec of tools) {
      const tool = raw.get(spec.name) ?? parseMcpToolName(spec.name)?.tool;
      if (tool === undefined) continue;
      unsubs.push(
        registry.register({
          spec,
          execute: async (_callId, params, signal) => {
            const r = await host.callTool(serverId, tool, params, { toolsListHash, signal });
            return { output: r.content, isError: r.isError, provenance: r.provenance };
          },
        }),
      );
    }
    return toolsListHash;
  };
  await sync();
  return { sync, unregister };
}
