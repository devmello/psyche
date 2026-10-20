// A dependency-free stdio MCP server (newline-delimited JSON-RPC, protocol 2025-11-25) with one
// read-only tool, `echo`.
import { createInterface } from "node:readline";

const tools = [
  {
    name: "echo",
    description: "Echo the text back.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
];
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  const ok = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  if (msg.method === "initialize") {
    return ok({
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "echo", version: "1.0.0" },
    });
  }
  if (msg.method === "ping") return ok({});
  if (msg.method === "tools/list") return ok({ tools });
  if (msg.method === "tools/call") {
    const text = String(msg.params?.arguments?.text ?? "");
    return ok({ content: [{ type: "text", text: `echo: ${text}` }] });
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
});
