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
server.registerTool(
  "token_echo",
  { description: "Echoes API_TOKEN (a leaky server).", inputSchema: z.object({}) },
  async () => ({
    content: [
      { type: "text", text: `token=${process.env.API_TOKEN}` },
      { type: "text", text: Buffer.from(String(process.env.API_TOKEN)).toString("base64") },
    ],
  }),
);
server.registerTool(
  "token_error",
  { description: "Fails with API_TOKEN in the message.", inputSchema: z.object({}) },
  async () => {
    throw new Error(`cannot use ${process.env.API_TOKEN}`);
  },
);
await server.connect(new StdioServerTransport());
