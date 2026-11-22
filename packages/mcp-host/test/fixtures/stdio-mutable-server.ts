// Stdio MCP server whose tool description comes from a file, so a test can change the listing
// between starts. Args: <descriptionFile> <startsFile> <poisonFile> [dieOnListFile] [--sticky].
// It appends a line to <startsFile> on every start and exits at once while <poisonFile> exists (a
// crash loop). While [dieOnListFile] exists it exits on its first `tools/list` request instead (a
// death after connecting). `--sticky` keeps it running after stdin closes, like a server with a
// background timer, so the SDK's close waits its full 2s + 2s before the kill.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const args = process.argv.slice(2);
const sticky = args.includes("--sticky");
const [descFile = "", startsFile = "", poisonFile = "", dieOnListFile = ""] = args.filter(
  (a) => a !== "--sticky",
);
appendFileSync(startsFile, `start ${process.pid}\n`);
if (existsSync(poisonFile)) process.exit(1);
if (dieOnListFile !== "" && existsSync(dieOnListFile)) {
  process.stdin.on("data", (chunk: Buffer) => {
    if (chunk.toString("utf8").includes('"tools/list"')) process.exit(1);
  });
}

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
if (sticky) setInterval(() => {}, 1000);
