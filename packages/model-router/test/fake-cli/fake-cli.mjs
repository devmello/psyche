#!/usr/bin/env node
// A stand-in for `claude` / `codex` in tests: replays a recorded script of JSON output lines
// and, like the real CLIs, starts the `psyche` MCP server it was configured with (the real
// relay script) and calls its tools. It never calls a model.
//
// Env: FAKE_CLI_SCRIPTS (JSON array of script paths, one per invocation), FAKE_CLI_STATE (a
// counter file), FAKE_CLI_LOG (JSONL of what the CLI saw: argv, env, stdin, tools, results).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (entry) => {
  if (process.env.FAKE_CLI_LOG)
    appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify(entry)}\n`);
};
const argv = process.argv.slice(2);
log({ kind: "argv", argv });
log({
  kind: "env",
  env: Object.fromEntries(
    ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MCP_TOOL_TIMEOUT", "DISABLE_TELEMETRY"].map((k) => [
      k,
      process.env[k] ?? null,
    ]),
  ),
});

// Probe commands: `--version`, `claude auth status --json`, `codex login status`.
if (argv[0] === "--version") {
  process.stdout.write(`${process.env.FAKE_CLI_VERSION ?? "2.1.286 (Claude Code)"}\n`);
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") {
  process.stdout.write(`${process.env.FAKE_CLI_AUTH ?? "{}"}\n`);
  process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status") {
  process.stderr.write(`${process.env.FAKE_CLI_LOGIN ?? "Not logged in"}\n`);
  process.exit(Number(process.env.FAKE_CLI_LOGIN_CODE ?? "1"));
}

const scripts = JSON.parse(process.env.FAKE_CLI_SCRIPTS ?? "[]");
const state = process.env.FAKE_CLI_STATE;
const n = state && existsSync(state) ? Number(readFileSync(state, "utf8")) : 0;
if (state) writeFileSync(state, String(n + 1));
const script = JSON.parse(readFileSync(scripts[Math.min(n, scripts.length - 1)], "utf8"));

const stdinLines = [];
const stdinWaiters = [];
let stdinClosed = false;
const rl = createInterface({ input: process.stdin });
rl.on("line", (l) => {
  log({ kind: "stdin", line: l });
  const w = stdinWaiters.shift();
  if (w) w(l);
  else stdinLines.push(l);
});
rl.on("close", () => {
  stdinClosed = true;
  for (const w of stdinWaiters.splice(0)) w(null);
});
const readLine = () =>
  stdinLines.length > 0
    ? Promise.resolve(stdinLines.shift())
    : stdinClosed
      ? Promise.resolve(null)
      : new Promise((r) => stdinWaiters.push(r));

function mcpServer() {
  const i = argv.indexOf("--mcp-config");
  if (i >= 0) return JSON.parse(argv[i + 1]).mcpServers.psyche;
  // codex: -c mcp_servers.psyche.<key>=<value>
  const cfg = {};
  argv.forEach((a, j) => {
    if (argv[j - 1] !== "-c") return;
    const m = /^mcp_servers\.psyche\.(\w+)=(.*)$/s.exec(a);
    if (!m) return;
    try {
      cfg[m[1]] = JSON.parse(m[2]);
    } catch {
      cfg[m[1]] = m[2]; // a TOML inline table (env)
    }
  });
  return cfg;
}

let mcp;
let seq = 0;
const pendingRpc = new Map();
function rpc(method, params, notify = false) {
  const msg = notify
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id: ++seq, method, params };
  mcp.stdin.write(`${JSON.stringify(msg)}\n`);
  if (notify) return Promise.resolve();
  return new Promise((r) => pendingRpc.set(msg.id, r));
}

const calls = new Map();
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

for (const step of script.steps) {
  if (step.read) {
    const line = await readLine();
    if (line === null) break;
  } else if (step.mcp === "start") {
    const s = mcpServer();
    mcp = spawn(s.command, s.args ?? [], {
      env: { ...process.env, ...(s.env ?? {}) },
      stdio: ["pipe", "pipe", "inherit"],
    });
    createInterface({ input: mcp.stdout }).on("line", (l) => {
      const m = JSON.parse(l);
      pendingRpc.get(m.id)?.(m);
      pendingRpc.delete(m.id);
    });
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fake" },
    });
    await rpc("notifications/initialized", {}, true);
    const list = await rpc("tools/list", {});
    log({ kind: "init", result: init.result });
    log({ kind: "tools", tools: list.result.tools });
  } else if (step.emit) {
    emit(step.emit);
  } else if (step.call) {
    calls.set(step.id, rpc("tools/call", step.call));
  } else if (step.await) {
    for (const id of step.await) {
      const res = await calls.get(id);
      log({ kind: "result", id, result: res.result ?? res.error });
    }
  } else if (step.sleep) {
    await new Promise((r) => setTimeout(r, step.sleep));
  } else if (step.hang) {
    await new Promise(() => {});
  } else if (step.exit !== undefined) {
    if (step.stderr) process.stderr.write(step.stderr);
    mcp?.kill();
    process.exit(step.exit);
  }
}
// Like the real CLI in stream-json mode: wait for stdin to close, then exit.
while ((await readLine()) !== null) {}
mcp?.kill();
process.exit(0);
