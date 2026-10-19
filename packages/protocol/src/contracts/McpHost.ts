import type { Sha256 } from "../common.ts";
import type { ToolSpec } from "../schemas/tools.ts";
import type { CallOptions } from "./Clock.ts";

/**
 * MCP host contract (architecture §4.9; security §11; owner S09). Tools are exposed as
 * `mcp__<server>__<tool>`. Grants bind to a hash of `tools/list`; a changed description or
 * schema changes `toolsListHash` and `callTool` with the old hash fails with `conflict`
 * ("rug pull" defense). Results from non-bundled servers are `untrusted`.
 */

export type McpTrustTier = "bundled" | "verified" | "unknown";

export type McpTransport =
  | { kind: "stdio"; command: string[]; env?: Record<string, string> }
  | { kind: "http"; url: string };

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  trust: McpTrustTier;
}

export interface McpServerInfo {
  id: string;
  name: string;
  trust: McpTrustTier;
  status: "connected" | "disconnected" | "error";
  protocolVersion?: string;
  toolsListHash?: Sha256;
}

export interface McpToolList {
  tools: ToolSpec[];
  toolsListHash: Sha256;
}

export interface McpCallOptions extends CallOptions {
  /** The hash the approval / grant was bound to. */
  toolsListHash: string;
  approvalId?: string;
}

export interface McpToolResult {
  content: unknown;
  isError: boolean;
  provenance: "trusted" | "untrusted";
}

export interface McpHost {
  listServers(): Promise<McpServerInfo[]>;
  addServer(config: McpServerConfig): Promise<McpServerInfo>;
  removeServer(serverId: string): Promise<void>;
  listTools(serverId: string): Promise<McpToolList>;
  /** `tool` is the server's own tool name (without the `mcp__` prefix). */
  callTool(
    serverId: string,
    tool: string,
    args: unknown,
    options: McpCallOptions,
  ): Promise<McpToolResult>;
}

/** `mcp__<server>__<tool>`, the key users see in allow / ask / deny rules. */
export type McpToolName = `mcp__${string}__${string}`;
