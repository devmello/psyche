// Minimal stdio MCP server (SDK v2) used to check vault env injection. Run with Node's type
// stripping: `node test/fixtures/stdio-env-server.ts`.
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const server = new McpServer({ name: "psyche-env", version: "1.0.0" });
server.registerTool(
  "token_length",
  {
    description: "Length of API_TOKEN.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  },
  async () => ({ content: [{ type: "text", text: String(process.env.API_TOKEN?.length ?? -1) }] }),
);
server.registerTool(
  "token_matches",
  {
    description: "Whether API_TOKEN equals the argument.",
    inputSchema: z.object({ guess: z.string() }),
  },
  async ({ guess }) => ({
    content: [{ type: "text", text: String(process.env.API_TOKEN === guess) }],
  }),
);
await server.connect(new StdioServerTransport());
