/**
 * The code a plugin's process runs first (`node --permission … --eval SHIM -- <main>`). It is a
 * string so the Gateway needs no extra file at run time. Before the plugin's module loads it
 * refuses network access (Node 24's permission model covers the file system, child processes,
 * workers and addons, not the network: this closes the common paths, it is not a boundary) and
 * moves console output to stderr, so stdout carries only the host protocol: one JSON object per
 * line each way, `{id, method, params}` in and `{id, result}` or `{id, error}` out.
 *
 * The plugin's module default-exports `(api) => void`; `api.on(capability, handler)` registers a
 * handler and throws for a capability the manifest did not declare.
 */
export const SHIM = String.raw`
import net from "node:net";
import dgram from "node:dgram";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const refuse = () => { throw new Error("plugins have no network access"); };
net.Socket.prototype.connect = refuse;
net.connect = refuse;
net.createConnection = refuse;
net.createServer = refuse;
dgram.createSocket = refuse;
globalThis.fetch = refuse;
globalThis.WebSocket = undefined;
globalThis.EventSource = undefined;
const toErr = (...a) => process.stderr.write(a.map(String).join(" ") + "\n");
console.log = console.info = console.warn = console.error = console.debug = toErr;

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const handlers = new Map();
let declared = new Set();

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  try {
    if (method === "init") {
      declared = new Set(params.capabilities);
      const api = Object.freeze({
        on(capability, handler) {
          if (!declared.has(capability)) throw new Error("capability " + capability + " is not declared in psyche-plugin.json");
          if (typeof handler !== "function") throw new Error("handler must be a function");
          handlers.set(capability, handler);
        },
      });
      const mod = await import(pathToFileURL(process.argv[1]).href);
      const setup = typeof mod.default === "function" ? mod.default : mod.register;
      if (typeof setup !== "function") throw new Error("the plugin module must default-export a function");
      await setup(api);
      send({ id, result: { registered: [...handlers.keys()] } });
      return;
    }
    const handler = handlers.get(method);
    if (handler === undefined) throw new Error("no handler for " + method);
    const result = await handler(params);
    send({ id, result: result === undefined ? null : result });
  } catch (err) {
    send({ id, error: String(err && err.message ? err.message : err).slice(0, 500) });
  }
});
`;
