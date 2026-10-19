import { PsycheError } from "@psyche/protocol";
import { runCli } from "./cli.ts";
import { createLogger } from "./log.ts";
import { startGateway } from "./server.ts";

const args = process.argv.slice(2);
if (args.length > 0) process.exit(runCli(args));

const log = createLogger();

try {
  const gateway = await startGateway({ logger: log });
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
