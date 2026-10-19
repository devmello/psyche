import { PsycheError } from "@psyche/protocol";
import { runCli } from "./cli.ts";
import { composeGateway, modelSetupFromEnv, NO_MODEL } from "./compose/index.ts";
import { createLogger } from "./log.ts";

const args = process.argv.slice(2);
if (args.length > 0) process.exit(runCli(args));

const log = createLogger();

try {
  const model = modelSetupFromEnv(process.env);
  if (model === null) log.log("warn", "no model configured (set PSYCHE_MODEL)", {});
  const gateway = await composeGateway({ logger: log, model: model ?? NO_MODEL });
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
