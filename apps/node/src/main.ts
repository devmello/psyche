import { existsSync } from "node:fs";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { parseArgs, usage } from "./config.ts";
import { loadOrCreateIdentity } from "./identity.ts";
import { createLogger } from "./log.ts";
import { createNodeRuntime, NODE_VERSION } from "./runtime.ts";

/** `psyche-node` entry point (run with `tsx`, like `psyched`). */
async function main(): Promise<number> {
  const { command, config } = parseArgs(process.argv.slice(2));
  if (command === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (command === "version") {
    process.stdout.write(`${NODE_VERSION}\n`);
    return 0;
  }
  const log = createLogger(undefined, process.env.PSYCHE_NODE_DEBUG === "1" ? "debug" : "info");
  const identity = loadOrCreateIdentity(config.home);
  if (command === "identity") {
    process.stdout.write(
      `${JSON.stringify({ deviceId: identity.deviceId, publicKey: identity.publicKey })}\n`,
    );
    return 0;
  }
  const localSocket = join(process.env.PSYCHE_HOME ?? join(config.home, ".."), "run", "node.sock");
  const runtime = await createNodeRuntime({
    config,
    identity,
    log,
    localSocket: existsSync(localSocket) ? localSocket : undefined,
  });
  if (command === "manifest") {
    process.stdout.write(`${JSON.stringify(await runtime.detect(), null, 2)}\n`);
    await runtime.stop();
    return 0;
  }
  const shutdown = (signal: string) => {
    log.log("info", "shutting down", { signal });
    void runtime.stop().then(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  await runtime.start();
  // The loop only returns on a fatal denial (revoked, key or role mismatch, version mismatch).
  return runtime.agent.state === "stopped" ? 0 : 78; // EX_CONFIG: launchd/systemd stop retrying
}

main().then(
  (code) => process.exit(code),
  (err) => {
    const e = PsycheError.from(err);
    process.stderr.write(`psyche-node: ${e.message}\n`);
    process.exit(e.code === "invalid_params" ? 64 : 1);
  },
);
