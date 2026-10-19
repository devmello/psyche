import type { McpHost } from "@psyche/protocol";

/** The two events of `@psyche/mcp-host`'s `onEvent` stream this adapter reacts to. */
export type McpLifecycleEvent =
  | { type: "tools_changed"; serverId: string; hash: string }
  | { type: string; serverId: string };

export interface McpGrantRevoker {
  revokeMcpGrants(serverId: string, currentToolsListHash: string): Promise<unknown>;
}

/** No stored grant has this hash, so passing it revokes every MCP grant of the server. */
const REMOVED = "removed";

/**
 * Ends MCP grants when what they were granted for changes (security §11, design-28):
 *
 * - `onEvent`: pass it as `createMcpHost({ onEvent })`; a `tools_changed` event revokes the
 *   server's grants bound to any other `tools/list` hash.
 * - `wrap(host)`: `removeServer` also revokes every grant of that server.
 *
 * Errors are reported through `onError` and never thrown into the host's event loop.
 */
export function mcpGrantRevocation(
  broker: McpGrantRevoker,
  onError: (err: unknown) => void = () => {},
): {
  onEvent(event: McpLifecycleEvent): void;
  wrap<H extends McpHost>(host: H): H;
} {
  const revoke = (serverId: string, hash: string) => {
    broker.revokeMcpGrants(serverId, hash).catch(onError);
  };
  return {
    onEvent(event) {
      if (event.type === "tools_changed" && "hash" in event) revoke(event.serverId, event.hash);
    },
    wrap(host) {
      const remove = host.removeServer.bind(host);
      host.removeServer = async (serverId: string) => {
        await remove(serverId);
        await broker.revokeMcpGrants(serverId, REMOVED).catch(onError);
      };
      return host;
    },
  };
}
