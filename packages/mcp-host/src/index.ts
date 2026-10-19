import { type McpHost, NotImplementedError } from "@psyche/protocol";

/**
 * Placeholder for the `McpHost` implementation owned by S09.
 * Build against `FakeMcpHost` from `@psyche/testing` until this lands.
 */
export function createMcpHost(): McpHost {
  throw new NotImplementedError("@psyche/mcp-host", "createMcpHost");
}
