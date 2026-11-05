/**
 * Drives the real system-bus client of password presence for tests/linux/polkit_dbusmock_test.py:
 * `preflight`, `prompt` (preflight, then the interactive check) or `cancel` (the interactive
 * check, cancelled after a moment). Prints one JSON line.
 *
 * The bus is the one DBUS_SYSTEM_BUS_ADDRESS names, opened through the test-only `presenceBusAt`
 * (this file reads the variable; the production module reads none). `preflight-production` uses
 * the production factory instead, which must ignore the variable and use the fixed socket.
 */
import {
  PRESENCE_ACTION_ID,
  preflight,
  presenceBusAt,
  systemPresenceBus,
} from "../../src/compose/password-presence.ts";

const command = process.argv[2] ?? "prompt";
const production = command === "preflight-production";
const testBus = process.env.DBUS_SYSTEM_BUS_ADDRESS;
if (!production && !testBus) throw new Error("DBUS_SYSTEM_BUS_ADDRESS is not set");
const bus = await (production ? systemPresenceBus : presenceBusAt(testBus ?? ""))();
const out: Record<string, unknown> = {};
try {
  const pre = await preflight(bus, process.getuid?.() ?? -1);
  out.pre = pre;
  if (
    !production &&
    command !== "preflight" &&
    pre.state === "ready" &&
    pre.sessionId !== undefined
  ) {
    const started = Date.now();
    const pending = bus.checkAuthorization(pre.sessionId, PRESENCE_ACTION_ID, 1, "psyche-test");
    if (command === "cancel") {
      setTimeout(() => void bus.cancelCheckAuthorization("psyche-test"), 400);
    }
    try {
      out.result = await pending;
    } catch (err) {
      out.error = (err as { dbusName?: string }).dbusName ?? String(err);
    }
    out.elapsedMs = Date.now() - started;
  }
} finally {
  bus.close();
}
console.log(JSON.stringify(out));
