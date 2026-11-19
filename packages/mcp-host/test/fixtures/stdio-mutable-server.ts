// Stdio MCP server whose tool description comes from a file, so a test can change the listing
// between starts. Args: <descriptionFile> <startsFile> <poisonFile>. It appends a line to
// <startsFile> on every start and exits at once while <poisonFile> exists (a crash loop).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const [descFile = "", startsFile = "", poisonFile = ""] = process.argv.slice(2);
appendFileSync(startsFile, `start ${process.pid}\n`);
if (existsSync(poisonFile)) process.exit(1);

const server = new McpServer({ name: "psyche-mutable", version: "1.0.0" });
server.registerTool(
  "ping",
  {
    description: readFileSync(descFile, "utf8"),
    inputSchema: z.object({ delayMs: z.number().optional() }),
    annotations: { readOnlyHint: true },
  },
  async ({ delayMs }) => {
    if (delayMs !== undefined) await new Promise((r) => setTimeout(r, delayMs));
    return { content: [{ type: "text", text: "pong" }] };
  },
);
await server.connect(new StdioServerTransport());
