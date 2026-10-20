import { PsycheError } from "@psyche/protocol";
import { runCli } from "./cli.ts";
import {
  composeGateway,
  modelSetupFromEnv,
  partsFromEnv,
  vaultModelSetup,
} from "./compose/index.ts";
import { createLogger } from "./log.ts";

const args = process.argv.slice(2);
if (args.length > 0) process.exit(runCli(args));

const log = createLogger();

try {
  // PSYCHE_MODEL (development, server mode) wins; otherwise provider keys come from the vault
  // and the model from the owner's pick in onboarding or Settings (a packaged first run).
  const model = modelSetupFromEnv(process.env) ?? vaultModelSetup(process.env);
  const gateway = await composeGateway({
    logger: log,
    model,
    parts: partsFromEnv(process.env),
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
