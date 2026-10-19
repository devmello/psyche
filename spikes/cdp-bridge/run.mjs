// One command: `npm start`. Launches the Electron app, waits for the bridge socket, runs the
// external client as a separate Node process, then shuts the app down.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const electron = createRequire(import.meta.url)("electron"); // path to the Electron binary
const app = spawn(electron, [path.join(here, "main.mjs")], {
  cwd: here,
  stdio: ["ignore", "pipe", "inherit"],
});
const keepOpen = process.argv.includes("--keep-open");

let started = false;
app.stdout.setEncoding("utf8");
app.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  const m = /BRIDGE_READY (\S+)/.exec(chunk);
  if (m && !started) {
    started = true;
    const client = spawn(process.execPath, [path.join(here, "client.mjs"), m[1]], {
      cwd: here,
      stdio: "inherit",
    });
    client.on("exit", (code) => {
      if (keepOpen) return console.log("[run] client done; app left open (--keep-open)");
      app.kill();
      process.exit(code ?? 1);
    });
  }
});
app.on("exit", (code) => {
  if (!started) {
    console.error(`[run] electron exited (${code}) before the bridge came up`);
    process.exit(1);
  }
});
