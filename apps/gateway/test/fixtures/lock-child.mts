// A process that tries to take the Gateway lock on a data folder, says what happened, and then
// holds the lock until it is killed (apps/gateway/test/gateway-lock.test.ts).
import { acquireGatewayLock } from "../../src/pre-update.ts";

const [home, impl] = process.argv.slice(2);
try {
  acquireGatewayLock(home as string, impl === "sqlite" ? { impl: "sqlite" } : {});
  process.stdout.write("OK\n");
} catch (err) {
  process.stdout.write(`FAIL ${(err as { details?: { reason?: string } }).details?.reason}\n`);
}
process.stdin.resume();
setInterval(() => undefined, 1_000);
