import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { runCli } from "./cli.ts";
import {
  composeGateway,
  modelSetupFromEnv,
  partsFromEnv,
  vaultModelSetup,
} from "./compose/index.ts";
import { createLogger } from "./log.ts";
import { rotatingFileSink } from "./log-rotation.ts";
import { defaultPeerChecker, packagedHelperInstalled } from "./transports/peer-check.ts";

const args = process.argv.slice(2);
if (args[0] === "--bundle-check") {
  const { bundleCheck } = await import("./bundle-check.ts");
  process.stdout.write(`${JSON.stringify(await bundleCheck())}\n`);
  process.exit(0);
}
if (args.length > 0) process.exit(await runCli(args));

// Logs go to a file the Gateway rotates itself (10 MB, three files), so they stay bounded without
// a newsyslog rule. launchd's StandardErrorPath still catches crashes.
const home = resolve(process.env.PSYCHE_HOME ?? join(homedir(), ".psyche"));
const log = createLogger(rotatingFileSink(join(home, "logs", "gateway.log")));
const peerChecker = defaultPeerChecker();

try {
  // PSYCHE_MODEL (development, server mode) wins; otherwise provider keys come from the vault
  // and the model from the owner's pick in onboarding or Settings (a packaged first run).
  const model = modelSetupFromEnv(process.env) ?? vaultModelSetup(process.env);
  const gateway = await composeGateway({
    logger: log,
    model,
    parts: partsFromEnv(process.env),
    // Linux: look at the process on the other end of the node socket before it is read from.
    // With the packaged helper installed only a verified (root-owned) peer can be the helper.
    ...(peerChecker === undefined
      ? {}
      : { peerChecker, peerCheckRequired: () => packagedHelperInstalled() }),
  });
  const shutdown = (signal: string) => {
    log.log("info", "signal received", { signal });
    gateway.stop(signal).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
} catch (err) {
  const e = PsycheError.from(err);
  log.log("error", "gateway failed to start", { code: e.code, message: e.message });
  process.exit(1);
}
