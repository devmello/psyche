import { type McpAppResource, mcpToolName, parseMcpToolName } from "@psyche/mcp-host";
import type { HandlerDef } from "../context.ts";

/**
 * `mcp.app` (generative-ui-2026 P9): the MCP App a tool declares, for the artifact sandbox. The
 * caller names a tool as the transcript shows it, never a URI: the resource is the one that
 * server's own pinned tool declares, read from the server that is running now. A tool the owner
 * switched off, a server that is not running and a tool with no app all answer `available: false`.
 */
export interface McpAppDeps {
  running(serverId: string): boolean;
  withheld(serverId: string, tool: string): boolean;
  host: {
    appResources(serverId: string): { tool: string; resourceUri: string }[];
    readAppResource(serverId: string, uri: string): Promise<McpAppResource>;
  };
}

export function mcpAppHandler(deps: McpAppDeps): HandlerDef {
  return {
    async run(_call, params: { tool: string }) {
      const parsed = parseMcpToolName(params.tool);
      if (parsed === undefined || !deps.running(parsed.serverId)) return { available: false };
      const decl = deps.host
        .appResources(parsed.serverId)
        .find((a) => mcpToolName(parsed.serverId, a.tool) === params.tool);
      if (decl === undefined || deps.withheld(parsed.serverId, decl.tool)) {
        return { available: false };
      }
      const r = await deps.host.readAppResource(parsed.serverId, decl.resourceUri);
      return {
        available: true,
        app: {
          serverId: r.serverId,
          uri: r.uri,
          html: r.html,
          csp: r.csp,
          permissions: r.permissions,
          provenance: "untrusted" as const,
        },
      };
    },
  };
}
