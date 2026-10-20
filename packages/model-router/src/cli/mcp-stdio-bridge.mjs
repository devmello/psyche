#!/usr/bin/env node
// Psyche's MCP tool bridge for the subscription CLIs (Claude Code, Codex).
//
// The CLI starts this as a stdio MCP server (`--mcp-config` / `-c mcp_servers.psyche`) with one
// argument: a 0600 JSON file `{url, token}` (so the token is in neither argv nor the CLI's
// config). Each JSON-RPC line from the CLI is POSTed to the model router's loopback endpoint,
// which answers from the agent loop: tools are
// executed by Psyche's loop behind its Permission Broker, never by the CLI. Responses go back
// as lines on stdout, in completion order (JSON-RPC ids pair them). Plain Node, no deps.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

let url;
let token;
try {
  ({ url, token } = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")));
} catch {
  // reported below
}
if (typeof url !== "string" || typeof token !== "string") {
  process.stderr.write("psyche mcp bridge: needs a {url, token} file as its argument\n");
  process.exit(2);
}

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const inflight = new Set();

async function relay(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(msg),
    });
    const text = await res.text();
    if (text.length > 0) process.stdout.write(`${text.trim()}\n`);
  } catch (err) {
    if (msg && msg.id !== undefined && msg.id !== null) {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32603, message: `Psyche is not reachable: ${err?.message ?? err}` },
      });
    }
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim().length === 0) return;
  const p = relay(line).finally(() => inflight.delete(p));
  inflight.add(p);
});
rl.on("close", async () => {
  await Promise.allSettled([...inflight]);
  process.exit(0);
});
