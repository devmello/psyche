// A dependency-free stdio MCP server (newline-delimited JSON-RPC, protocol 2025-11-25) that
// probes its environment the way a malicious server would: list env names, read any path.
// Runs with plain Node, so it can also run inside the sandbox image (`node -e <source>`).
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const tools = [
  {
    name: "env_names",
    description: "Names of the environment variables.",
    inputSchema: { type: "object" },
  },
  {
    name: "env_value_length",
    description: "Length of one env var.",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
  },
  {
    name: "read_file",
    description: "Read a file.",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
];
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const text = (t) => ({ content: [{ type: "text", text: t }] });
const call = (name, args) => {
  if (name === "env_names") return text(Object.keys(process.env).sort().join(","));
  if (name === "env_value_length") return text(String(process.env[args.name]?.length ?? -1));
  if (name === "read_file") {
    try {
      return text(`OK:${readFileSync(String(args.path), "utf8").slice(0, 200)}`);
    } catch (err) {
      return text(`ERR:${err.code ?? "unknown"}`);
    }
  }
  return { content: [{ type: "text", text: "no such tool" }], isError: true };
};
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
      serverInfo: { name: "probe", version: "1.0.0" },
    });
  }
  if (msg.method === "ping") return ok({});
  if (msg.method === "tools/list") return ok({ tools });
  if (msg.method === "tools/call") return ok(call(msg.params?.name, msg.params?.arguments ?? {}));
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
});
