/**
 * The MCP client SDK, imported on the first connection (docs/design/lightweight-2026.md): about
 * 4 MB of heap that a Gateway with no MCP server configured never needs.
 */
export type McpSdk = typeof import("@modelcontextprotocol/client");
export type McpStdioSdk = typeof import("@modelcontextprotocol/client/stdio");

let sdk: McpSdk | undefined;
let stdio: McpStdioSdk | undefined;

export async function loadMcpSdk(): Promise<McpSdk> {
  sdk ??= await import("@modelcontextprotocol/client");
  return sdk;
}

export async function loadMcpStdioSdk(): Promise<McpStdioSdk> {
  stdio ??= await import("@modelcontextprotocol/client/stdio");
  return stdio;
}

/** The SDK if a connection already loaded it; error classes from it can only exist then. */
export function loadedMcpSdk(): McpSdk | undefined {
  return sdk;
}
