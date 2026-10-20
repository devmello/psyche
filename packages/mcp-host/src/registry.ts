import type {
  McpHost,
  McpTrustTier,
  ToolCallDescription,
  ToolRegistry,
  Unsubscribe,
} from "@psyche/protocol";
import { sha256, strictCanonicalJSON } from "./canonical.ts";
import { mcpToolName, parseMcpToolName } from "./naming.ts";

/**
 * Security §3.5 / data model §4.2 for `connector_action` / MCP tool calls: the binding covers
 * server id, tool name, `tools/list` hash and an args hash; standing grants bind to server +
 * tool + hash, so a changed listing never inherits a grant.
 */
export function describeMcpCall(
  serverId: string,
  tool: string,
  toolsListHash: string,
  params: unknown,
  tier: McpTrustTier = "unknown",
): ToolCallDescription {
  let argsSha256: string;
  try {
    argsSha256 = sha256(strictCanonicalJSON(params ?? {}));
  } catch {
    argsSha256 = sha256(String(params));
  }
  return {
    kind: "connector_action",
    target: { kind: "account", value: `mcp:${serverId}`, display: `MCP server ${serverId}` },
    // The field names of the broker's `mcp_tool` / `connector_action` binding (binding.ts).
    bindingFields: { serverId, tool, toolsListHash, argsSha256 },
    grantKey: `mcp:${serverId}:${tool}:${toolsListHash}`,
    // The broker binds grants to the server and hash (revokeMcpGrants, #279) and asks for
    // write+ tools of unknown servers (#280).
    meta: { mcpServerId: serverId, mcpToolsListHash: toolsListHash, mcpTier: tier },
    summary: `Called ${tool} on ${serverId}`,
  };
}

/**
 * Registers a server's tools into the agent-core registry as `mcp__<server>__<tool>`. Each
 * executor carries the `tools/list` hash the registration saw, so after a change every call
 * fails with `conflict` until `sync()` re-registers the new listing (whose standing grants are
 * new keys: the owner is asked again).
 */
export interface McpRegistration {
  /** Re-list and re-register; returns the hash now registered. */
  sync(): Promise<string>;
  /** The `tools/list` hash the current registrations are bound to. */
  readonly hash: string;
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
  let registered = "";
  const unregister = () => {
    for (const u of unsubs) u();
    unsubs = [];
  };
  const sync = async () => {
    const { tools, toolsListHash } = await host.listTools(serverId);
    // Unknown unless the host says otherwise: an unlisted server asks (security §11).
    const tier: McpTrustTier =
      (await host.listServers()).find((s) => s.id === serverId)?.trust ?? "unknown";
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
          describeCall: (params) => describeMcpCall(serverId, tool, toolsListHash, params, tier),
          execute: async (_callId, params, signal) => {
            const r = await host.callTool(serverId, tool, params, { toolsListHash, signal });
            return { output: r.content, isError: r.isError, provenance: r.provenance };
          },
        }),
      );
    }
    registered = toolsListHash;
    return toolsListHash;
  };
  await sync();
  return {
    sync,
    unregister,
    get hash() {
      return registered;
    },
  };
}
